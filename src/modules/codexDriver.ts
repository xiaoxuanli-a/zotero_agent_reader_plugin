// @ts-nocheck
/*
 * codexDriver.ts — codex-aware driver. Spawns `codex exec` / `codex exec resume`
 * via Mozilla's Subprocess (privileged chrome / Zotero only) and streams
 * AgentEvents through the event mapper. In the app-server build this is kept
 * mainly for the `codex --version` healthcheck banner.
 *
 * `buildArgv` is pure (no Gecko APIs) and is unit-testable. Everything else
 * touches Subprocess only at call time.
 *
 * Mirrors app/agent/codex_driver.py. Subprocess pattern follows the shipping
 * zotero-ocr plugin (ChromeUtils.importESModule + readString loop).
 */
import { consume } from "./eventMapper";

export function buildArgv(workdir, sessionId, prompt, opts) {
  opts = opts || {};
  var sandbox = opts.sandbox || "read-only";
  var argv;
  if (sessionId == null) {
    // First turn: bind cwd + sandbox here (resume can't set them).
    argv = ["exec", prompt, "-C", workdir, "--sandbox", sandbox,
            "-c", "approval_policy=never", "--skip-git-repo-check", "--json"];
  } else {
    // Resume: cwd inherited; sandbox/approval re-asserted via -c.
    argv = ["exec", "resume", sessionId, prompt,
            "-c", "sandbox_mode=" + sandbox, "-c", "approval_policy=never",
            "--skip-git-repo-check", "--json"];
  }
  if (opts.webSearch !== false) argv.push("-c", "tools.web_search=true");
  if (opts.model) argv.push("-m", opts.model);
  return argv;
}

function getSubprocess() {
  return ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
}

async function resolveCommand(Subprocess, env, configuredPath) {
  if (configuredPath) return configuredPath;
  return await Subprocess.pathSearch("codex", env); // throws if not found
}

// A GUI-launched Zotero (esp. macOS) does NOT inherit the login shell's PATH,
// so the spawned codex can't find `node` (its shebang is `env node`) or
// `pdftotext` even when codexPath is set — failing with `env: node: No such
// file or directory` (exit 127). Prepend the usual package-manager bin dirs
// (and the configured codex's own dir) to PATH so codex + its child tools
// resolve. `env` is the object from Subprocess.getEnvironment(); mutated in place.
function augmentEnvPath(env, opts) {
  try { if (Services.appinfo.OS === "WINNT") return env; } catch (e) {} // POSIX PATHs only
  var extra = [];
  if (opts && opts.codexPath) {
    var i = opts.codexPath.lastIndexOf("/");
    if (i > 0) extra.push(opts.codexPath.slice(0, i));
  }
  extra = extra.concat(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
  var parts = (env.PATH || "").split(":").filter(Boolean);
  var prepend = [];
  for (var e = 0; e < extra.length; e++) {
    if (extra[e] && prepend.indexOf(extra[e]) < 0 && parts.indexOf(extra[e]) < 0) prepend.push(extra[e]);
  }
  env.PATH = prepend.concat(parts).join(":");
  return env;
}

// Drive one turn. `onEvent(AgentEvent)` is called as events stream in.
// `liveRef` (optional) gets a `.kill()` so the caller can cancel on teardown.
export async function runTurn(opts, workdir, sessionId, prompt, onEvent, liveRef) {
  opts = opts || {};
  var Subprocess = getSubprocess();
  var env = Subprocess.getEnvironment();
  augmentEnvPath(env, opts);

  var command;
  try {
    command = await resolveCommand(Subprocess, env, opts.codexPath);
  } catch (e) {
    onEvent({ kind: "error", message: "codex not found on PATH — set its absolute path in preferences." });
    return { exitCode: -1 };
  }

  var argv = buildArgv(workdir, sessionId, prompt, opts);
  var proc;
  try {
    proc = await Subprocess.call({
      command: command,
      arguments: argv,
      workdir: workdir,
      environment: env,
      environmentAppend: true,
      stderr: "pipe",
    });
  } catch (e) {
    onEvent({ kind: "error", message: "failed to start codex: " + e });
    return { exitCode: -1 };
  }

  // codex `exec` also reads "additional input" from stdin and appends it to the
  // prompt; with the Subprocess stdin pipe left open it blocks forever (the turn
  // hangs at "thinking…"). Close stdin so codex gets EOF and proceeds with the arg.
  try { proc.stdin.close(); } catch (e) {}

  var killed = false;
  if (liveRef) liveRef.kill = function () { killed = true; try { proc.kill(); } catch (e) {} };

  var timeoutMs = (opts.timeoutSec || 600) * 1000;
  var timer = setTimeout(function () {
    killed = true;
    try { proc.kill(); } catch (e) {}
    onEvent({ kind: "error", message: "codex turn timed out after " + (timeoutMs / 1000) + "s" });
  }, timeoutMs);

  var buffer = "";
  var sawTerminal = false;
  try {
    var chunk;
    while ((chunk = await proc.stdout.readString())) {
      var r = consume(buffer, chunk);
      buffer = r.buffer;
      for (var i = 0; i < r.events.length; i++) {
        var ev = r.events[i];
        if (ev.kind === "done" || ev.kind === "error") sawTerminal = true;
        onEvent(ev);
      }
    }
    var res = await proc.wait();
    clearTimeout(timer);
    if (!killed && !sawTerminal) {
      if (res.exitCode !== 0) {
        var err = "";
        try { err = await proc.stderr.readString(); } catch (e) {}
        onEvent({ kind: "error", message: "codex exited " + res.exitCode + (err ? ": " + String(err).slice(-400) : "") });
      } else {
        onEvent({ kind: "done" });
      }
    }
    return res;
  } catch (e) {
    clearTimeout(timer);
    if (!sawTerminal) onEvent({ kind: "error", message: "codex stream error: " + e });
    try { proc.kill(); } catch (e2) {}
    return { exitCode: -1 };
  }
}

export async function healthcheck(opts) {
  opts = opts || {};
  try {
    var Subprocess = getSubprocess();
    var env = Subprocess.getEnvironment();
    augmentEnvPath(env, opts);
    var command;
    try { command = await resolveCommand(Subprocess, env, opts.codexPath); }
    catch (e) { return { ok: false, error: "codex not found on PATH" }; }
    var proc = await Subprocess.call({ command: command, arguments: ["--version"], environment: env, environmentAppend: true });
    var out = "", c;
    while ((c = await proc.stdout.readString())) out += c;
    var res = await proc.wait();
    return { ok: res.exitCode === 0, version: String(out).trim() };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

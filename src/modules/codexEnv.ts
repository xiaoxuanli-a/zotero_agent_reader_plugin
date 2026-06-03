// @ts-nocheck
/*
 * codexEnv.ts — locate the `codex` binary + build the environment to run it in.
 * Shared by appServer.ts (the live driver) and codexDriver.ts (healthcheck).
 *
 * GUI-launched Zotero does NOT inherit the login shell's PATH, so a codex in a
 * non-standard dir (nvm/volta/asdf, ~/.local/bin from `codex update`, …) is
 * invisible to a bare pathSearch. Resolution order:
 *   1. explicit `codexPath` pref — always wins.
 *   2. FAST PATH: augment PATH with the usual bin dirs, then pathSearch.
 *   3. FALLBACK: ask the user's LOGIN shell where codex is + what PATH it uses
 *      (`$SHELL -lic`), exactly how VS Code & co. resolve the shell environment.
 *      Result is cached for the process (we spawn the shell at most once).
 * Windows is left to the OS PATH (GUI apps inherit the system env there).
 */

function getSubprocess() {
  return ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs")
    .Subprocess;
}

function isWindows() {
  try {
    return Services.appinfo.OS === "WINNT";
  } catch (e) {
    return false;
  }
}

function log(m) {
  try {
    Zotero.debug("[PaperReadingAgent] codexEnv: " + m);
  } catch (e) {
    /* ignore */
  }
}

// Usual package-manager bin dirs (fast path — no shell spawn). ~/.local/bin is
// where `codex update` self-installs; listed first so it beats an older
// `npm i -g` copy in /opt/homebrew/bin.
function commonBins(env, opts) {
  var extra = [];
  if (opts && opts.codexPath) {
    var i = opts.codexPath.lastIndexOf("/");
    if (i > 0) extra.push(opts.codexPath.slice(0, i));
  }
  if (env.HOME) extra.push(env.HOME + "/.local/bin");
  return extra.concat(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
}

// Prepend dirs not already present to env.PATH. Mutates + returns env.
function augmentEnvPath(env, opts) {
  if (isWindows()) return env;
  var extra = commonBins(env, opts);
  var parts = (env.PATH || "").split(":").filter(Boolean);
  var pre = [];
  for (var e = 0; e < extra.length; e++) {
    if (extra[e] && pre.indexOf(extra[e]) < 0 && parts.indexOf(extra[e]) < 0)
      pre.push(extra[e]);
  }
  env.PATH = pre.concat(parts).join(":");
  return env;
}

// { codex: <abs path|null>, path: <login PATH|null> } — resolved once, cached.
var SHELL_CACHE = null;
export function clearCache() {
  SHELL_CACHE = null;
}

function between(s, a, b) {
  var i = s.indexOf(a);
  if (i < 0) return null;
  var j = s.indexOf(b, i + a.length);
  if (j < 0) return null;
  return s.slice(i + a.length, j).trim();
}

// Spawn the user's LOGIN shell once to capture codex's location + the real PATH.
async function resolveViaLoginShell(Subprocess, env) {
  if (SHELL_CACHE) return SHELL_CACHE;
  SHELL_CACHE = { codex: null, path: null };
  if (isWindows()) return SHELL_CACHE;
  var shell = env.SHELL || "/bin/bash";
  // -l login (sources profile) + -i interactive (sources rc, where PATH edits
  // usually live) + -c run-and-exit. START/END markers survive rc banner noise.
  var script =
    "echo __PRA_C_S__; command -v codex 2>/dev/null; echo __PRA_C_E__; " +
    'echo __PRA_P_S__; echo "$PATH"; echo __PRA_P_E__';
  var proc = null;
  try {
    proc = await Subprocess.call({
      command: shell,
      arguments: ["-lic", script],
      environment: env,
      environmentAppend: true,
      stderr: "pipe",
    });
    try {
      proc.stdin.close();
    } catch (e) {
      /* ignore */
    }
    var readAll = (async function () {
      var out = "",
        c;
      while ((c = await proc.stdout.readString())) out += c;
      return out;
    })();
    // a heavy rc (instant-prompt, etc.) could hang; bail after 6s.
    var timer = new Promise(function (res) {
      setTimeout(function () {
        res(null);
      }, 6000);
    });
    var out = await Promise.race([readAll, timer]);
    if (out === null) {
      log("login-shell timed out");
      try {
        proc.kill();
      } catch (e) {
        /* ignore */
      }
      return SHELL_CACHE;
    }
    try {
      await proc.wait();
    } catch (e) {
      /* ignore */
    }
    var codex = between(out, "__PRA_C_S__", "__PRA_C_E__");
    var path = between(out, "__PRA_P_S__", "__PRA_P_E__");
    if (codex) SHELL_CACHE.codex = codex.split("\n").filter(Boolean).pop();
    if (path) SHELL_CACHE.path = path.split("\n").filter(Boolean).pop();
    log(
      "login-shell: codex=" +
        SHELL_CACHE.codex +
        " pathLen=" +
        (SHELL_CACHE.path ? SHELL_CACHE.path.length : 0),
    );
  } catch (e) {
    log("login-shell failed: " + e);
    if (proc) {
      try {
        proc.kill();
      } catch (e2) {
        /* ignore */
      }
    }
  }
  return SHELL_CACHE;
}

// Resolve { command, env } to spawn codex with. `env` already has an augmented
// PATH so codex's own node/pdftotext children resolve too. Throws if not found.
export async function resolveCodex(opts) {
  opts = opts || {};
  var Subprocess = getSubprocess();
  var env = augmentEnvPath(Subprocess.getEnvironment(), opts);

  // 1. explicit pref wins
  if (opts.codexPath) return { command: opts.codexPath, env: env };

  // 2. fast path: pathSearch over the whitelisted PATH
  try {
    return { command: await Subprocess.pathSearch("codex", env), env: env };
  } catch (e) {
    /* fall through to the login shell */
  }

  // 3. fallback: ask the login shell, and merge its PATH so children resolve
  var r = await resolveViaLoginShell(Subprocess, env);
  if (r.path) {
    var parts = (env.PATH || "").split(":").filter(Boolean);
    var add = r.path.split(":").filter(Boolean).filter(function (d) {
      return parts.indexOf(d) < 0;
    });
    if (add.length) env.PATH = parts.concat(add).join(":");
  }
  if (r.codex) return { command: r.codex, env: env };
  // last try with the merged login PATH
  try {
    return { command: await Subprocess.pathSearch("codex", env), env: env };
  } catch (e) {
    throw new Error(
      "codex not found — install it, or set its absolute path in preferences (extensions.paper-reading-agent.codexPath).",
    );
  }
}

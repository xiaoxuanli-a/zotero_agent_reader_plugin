/*
 * Node unit test for the portable codex logic — runs WITHOUT Zotero.
 * Feeds the recorded real codex 0.130 JSONL fixture through the streaming
 * `consume()` in awkward chunk sizes (proving buffer+split robustness), then
 * asserts the produced AgentEvent sequence. Also checks buildArgv (exec/resume).
 *
 *   node test/eventMapper.test.js
 */
const fs = require("fs");
const path = require("path");

const Mapper = require("../content/eventMapper.js");
const Driver = require("../content/codexDriver.js"); // pulls buildArgv (pure)

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/codex-0.130.jsonl"), "utf8");

let failures = 0;
function check(name, cond) {
  console.log((cond ? "  ok   " : "  FAIL ") + name);
  if (!cond) failures++;
}

// --- streaming map over the real fixture, fed in 7-byte chunks ---
let buf = "";
const events = [];
for (let i = 0; i < fixture.length; i += 7) {
  const r = Mapper.consume(buf, fixture.slice(i, i + 7));
  buf = r.buffer;
  events.push(...r.events);
}
const kinds = events.map((e) => e.kind);
console.log("\nevent kinds:", kinds.join(", "));

const ts = events.find((e) => e.kind === "thread_started");
check("captured thread_started with a sessionId", !!(ts && ts.sessionId));
check("at least one delta (assistant message)", kinds.includes("delta"));
check("every delta has non-empty text", events.filter((e) => e.kind === "delta").every((e) => e.text && e.text.length));
check("at least one tool chip (command_execution)", kinds.includes("tool"));
check("every tool event has a toolName", events.filter((e) => e.kind === "tool").every((e) => e.toolName));
check("terminates with done", kinds[kinds.length - 1] === "done");
check("done carries usage", !!events.find((e) => e.kind === "done" && e.usage));

// --- same result when fed as a single blob (chunk-size independence) ---
const blob = Mapper.consume("", fixture);
check("one-blob feed yields the same kind sequence", JSON.stringify(blob.events.map((e) => e.kind)) === JSON.stringify(kinds));

// --- synthetic error + rate-limit friendliness ---
const err = Mapper.mapEvent({ type: "turn.failed", error: { message: "Rate limit exceeded for requests" } });
check("turn.failed -> single error event", err.length === 1 && err[0].kind === "error");
check("rate-limit error is rewritten friendly", /rate limited/i.test(err[0].message));

// --- buildArgv: first turn (exec) vs resume ---
const a1 = Driver.buildArgv("/work/x", null, "hello", { webSearch: true });
check("first turn uses `exec` + -C + --sandbox read-only", a1[0] === "exec" && a1.includes("-C") && a1.includes("--sandbox") && a1.includes("read-only"));
check("first turn enables web_search via -c", a1.join(" ").includes("tools.web_search=true"));
check("first turn sets approval_policy=never + --json + --skip-git-repo-check", a1.join(" ").includes("approval_policy=never") && a1.includes("--json") && a1.includes("--skip-git-repo-check"));
const a2 = Driver.buildArgv("/work/x", "SESSION-123", "again", {});
check("resume uses `exec resume <id>` and NO -C/--sandbox flags", a2[0] === "exec" && a2[1] === "resume" && a2[2] === "SESSION-123" && !a2.includes("-C") && !a2.includes("--sandbox"));
check("resume re-asserts sandbox_mode via -c", a2.join(" ").includes("sandbox_mode=read-only"));
const a3 = Driver.buildArgv("/w", null, "p", { model: "gpt-5.5", webSearch: false });
check("model -> -m, webSearch:false omits tools.web_search", a3.includes("-m") && a3.includes("gpt-5.5") && !a3.join(" ").includes("tools.web_search"));

console.log(failures ? `\n${failures} FAILURE(S)` : "\nALL PASS");
process.exit(failures ? 1 : 0);

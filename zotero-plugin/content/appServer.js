/*
 * appServer.js — drive codex via a PERSISTENT `codex app-server` (stdio JSON-RPC)
 * to get TRUE token-level streaming (the `item/agentMessage/delta` notifications),
 * instead of the whole-message-at-once `codex exec --json`.
 *
 * Protocol (verified live against codex-cli 0.130.0, app-server generate-json-schema):
 *   line-delimited JSON-RPC 2.0 over stdin/stdout.
 *   handshake:  → initialize {clientInfo}        ← {userAgent,...}
 *               → initialized (notification)
 *   per paper:  → thread/start {cwd,approvalPolicy,sandbox}  ← {thread:{id}}   (or thread/resume {threadId})
 *   per turn:   → turn/start {threadId,input:[{type:"text",text}]}  ← {turn:{id}}
 *               ← item/agentMessage/delta {delta,itemId,threadId,turnId}   ← TOKEN STREAM
 *               ← item/completed {item:{type:"agentMessage",text}}         (full text, for reconcile)
 *               ← turn/completed {threadId,turn}                           (done)
 *   cancel:     → turn/interrupt {threadId,turnId}
 *
 * Exposes runTurn(opts, workdir, threadId, prompt, onEvent, liveRef) — same contract
 * as PRACodexDriver.runTurn, emitting: thread_started | delta (token, CONCATENATED by
 * chatService) | tool | done | error. EXPERIMENTAL codex protocol — pinned to 0.130.x.
 */
(function (root) {
  "use strict";

  var ENC = null;
  function encode(s) { if (!ENC) ENC = new TextEncoder(); return ENC.encode(s); }

  // ---- persistent process + JSON-RPC state ----
  // S.turns maps threadId -> active turn, so MULTIPLE papers can stream CONCURRENTLY:
  // every per-turn notification carries threadId/turnId and routes to the right turn.
  var S = {
    proc: null, ready: null, nextId: 1, pending: Object.create(null),
    activeThreads: null, turns: Object.create(null),
  };

  function getSubprocess() {
    return ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
  }

  // GUI Zotero lacks the login-shell PATH; prepend the usual bins so codex + its
  // `node`/`pdftotext` children resolve (mirrors codexDriver.augmentEnvPath).
  function augmentEnvPath(env, opts) {
    try { if (Services.appinfo.OS === "WINNT") return env; } catch (e) {}
    var extra = [];
    if (opts && opts.codexPath) { var i = opts.codexPath.lastIndexOf("/"); if (i > 0) extra.push(opts.codexPath.slice(0, i)); }
    extra = extra.concat(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]);
    var parts = (env.PATH || "").split(":").filter(Boolean);
    var pre = [];
    for (var e = 0; e < extra.length; e++) if (extra[e] && pre.indexOf(extra[e]) < 0 && parts.indexOf(extra[e]) < 0) pre.push(extra[e]);
    env.PATH = pre.concat(parts).join(":");
    return env;
  }

  function log(m) { try { Zotero.debug("[PaperReadingAgent] appServer: " + m); } catch (e) {} }

  function send(obj) {
    if (!S.proc) return Promise.reject(new Error("app-server not running"));
    try { return S.proc.stdin.write(encode(JSON.stringify(obj) + "\n")); }
    catch (e) { return Promise.reject(e); }
  }

  function request(method, params) {
    var id = S.nextId++;
    var p = new Promise(function (resolve, reject) { S.pending[id] = { resolve: resolve, reject: reject }; });
    send({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return p;
  }
  function notify(method, params) { return send({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function dispatch(msg) {
    if (msg.id != null && (("result" in msg) || ("error" in msg))) {
      var pend = S.pending[msg.id];
      if (pend) { delete S.pending[msg.id]; msg.error ? pend.reject(new Error(JSON.stringify(msg.error))) : pend.resolve(msg.result); }
      return;
    }
    if (msg.id != null && msg.method) {            // server request (approval/elicitation)
      // approvalPolicy:never + read-only means these shouldn't fire; decline to avoid a hang.
      log("server request " + msg.method + " → declining");
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "client declines " + msg.method } });
      return;
    }
    if (msg.method) routeNotification(msg.method, msg.params || {});
  }

  // Map an app-server notification onto the RIGHT turn's AgentEvent stream (by threadId).
  function routeNotification(method, p) {
    var t = null;
    if (p.threadId) t = S.turns[p.threadId];                                      // route by thread → concurrency-safe
    else { var ks = Object.keys(S.turns); if (ks.length === 1) t = S.turns[ks[0]]; } // threadId-less notif: only if a single turn is active
    if (!t) return;

    if (method === "item/agentMessage/delta") {
      if (typeof p.delta === "string" && p.delta.length) { t.gotText = true; t.onEvent({ kind: "delta", text: p.delta }); }
      return;
    }
    if (method === "item/started") {
      var it = p.item || {}, ty = it.type;
      if (ty === "agentMessage") { if (t.gotText) t.onEvent({ kind: "delta", text: "\n\n" }); } // paragraph break between messages
      else if (ty === "reasoning") { t.onEvent({ kind: "tool", toolName: "reasoning", detail: "" }); } // surface the (often long, silent) reasoning phase so the UI isn't frozen
      else if (ty === "commandExecution" || ty === "webSearch" || ty === "mcpToolCall" || ty === "fileChange") {
        var d = it.command || it.query || it.name || it.server || "";
        if (Array.isArray(d)) d = d.join(" ");
        t.onEvent({ kind: "tool", toolName: ty, detail: String(d) });
      }
      return;
    }
    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
      t.onEvent({ kind: "tool", toolName: "reasoning", detail: "" });   // surface "thinking…"
      return;
    }
    if (method === "turn/completed") { finishTurn(t, { kind: "done" }); return; }
    if (method === "turn/failed" || method === "error") {
      finishTurn(t, { kind: "error", message: (p && (p.message || JSON.stringify(p))) || "turn failed" });
      return;
    }
  }

  function finishTurn(t, ev) {
    if (t.finished) return;
    t.finished = true;
    if (t.timer) { try { clearTimeout(t.timer); } catch (e) {} }
    if (t.threadId && S.turns[t.threadId] === t) delete S.turns[t.threadId];
    t.onEvent(ev);
    t.resolve();
  }

  async function readLoop(proc) {
    var buffer = "";
    try {
      var chunk;
      while ((chunk = await proc.stdout.readString())) {
        buffer += chunk;
        var nl;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          var line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
          if (!line) continue;
          var msg; try { msg = JSON.parse(line); } catch (e) { continue; }
          try { dispatch(msg); } catch (e) { log("dispatch error: " + e); }
        }
      }
    } catch (e) { log("read loop ended: " + e); }
    onProcExit();
  }

  function onProcExit() {
    var keys = Object.keys(S.pending);
    for (var i = 0; i < keys.length; i++) { try { S.pending[keys[i]].reject(new Error("app-server exited")); } catch (e) {} }
    S.pending = Object.create(null);
    var tks = Object.keys(S.turns);
    for (var j = 0; j < tks.length; j++) { try { finishTurn(S.turns[tks[j]], { kind: "error", message: "codex app-server exited" }); } catch (e) {} }
    S.turns = Object.create(null);
    S.proc = null; S.ready = null; S.activeThreads = null;
  }

  // Idempotent + race-safe: sets S.ready (the in-flight promise) synchronously, so two
  // concurrent runTurns (two papers asked at once) share ONE app-server, not two.
  function ensureReady(opts) {
    if (S.ready) return S.ready;
    S.ready = startServer(opts).catch(function (e) { S.ready = null; S.proc = null; throw e; });
    return S.ready;
  }
  async function startServer(opts) {
    var Subprocess = getSubprocess();
    var env = augmentEnvPath(Subprocess.getEnvironment(), opts);
    var command;
    try { command = opts.codexPath || await Subprocess.pathSearch("codex", env); }
    catch (e) { throw new Error("codex not found on PATH — set its absolute path in preferences."); }

    var argv = ["app-server"];
    if (opts.webSearch !== false) argv.push("-c", "tools.web_search=true");
    if (opts.model) argv.push("-c", "model=" + JSON.stringify(opts.model));

    var proc = await Subprocess.call({
      command: command, arguments: argv, environment: env, environmentAppend: true, stderr: "pipe",
    });
    S.proc = proc; S.activeThreads = Object.create(null);
    readLoop(proc); // fire-and-forget; runs for the life of the process
    await request("initialize", { clientInfo: { name: "paper-reading-agent", version: "0.1.0" } });
    await notify("initialized");
    log("ready");
  }

  // Ensure a thread exists in THIS server (start a new one or resume a persisted id).
  async function ensureThread(workdir, threadId, opts, onEvent) {
    var common = { cwd: workdir, approvalPolicy: "never", sandbox: opts.sandbox || "read-only" };
    if (threadId && S.activeThreads[threadId]) return threadId;
    if (threadId) {
      try {
        var r = await request("thread/resume", Object.assign({ threadId: threadId }, common));
        var id = (r && r.thread && r.thread.id) || threadId;
        S.activeThreads[id] = 1; return id;
      } catch (e) { log("resume failed (" + e + "), starting fresh"); }
    }
    var rs = await request("thread/start", common);
    var nid = rs && rs.thread && rs.thread.id;
    if (!nid) throw new Error("thread/start returned no thread id");
    S.activeThreads[nid] = 1;
    if (onEvent) onEvent({ kind: "thread_started", sessionId: nid });
    return nid;
  }

  // Same contract as PRACodexDriver.runTurn.
  async function runTurn(opts, workdir, threadId, prompt, onEvent, liveRef) {
    opts = opts || {};
    try { await ensureReady(opts); }
    catch (e) { onEvent({ kind: "error", message: String(e && e.message ? e.message : e) }); return { exitCode: -1 }; }

    var tid;
    try { tid = await ensureThread(workdir, threadId, opts, onEvent); }
    catch (e) { onEvent({ kind: "error", message: "failed to open codex thread: " + e }); return { exitCode: -1 }; }

    var done;
    var donePromise = new Promise(function (res) { done = res; });
    var turn = { threadId: tid, turnId: null, onEvent: onEvent, resolve: done, finished: false, gotText: false, timer: null };
    S.turns[tid] = turn;

    if (liveRef) liveRef.kill = function () {
      if (turn.turnId) { try { request("turn/interrupt", { threadId: tid, turnId: turn.turnId }); } catch (e) {} }
      finishTurn(turn, { kind: "error", message: "cancelled" });
    };
    var timeoutMs = (opts.timeoutSec || 600) * 1000;
    turn.timer = setTimeout(function () {
      if (turn.turnId) { try { request("turn/interrupt", { threadId: tid, turnId: turn.turnId }); } catch (e) {} }
      finishTurn(turn, { kind: "error", message: "codex turn timed out after " + (timeoutMs / 1000) + "s" });
    }, timeoutMs);

    try {
      var turnParams = { threadId: tid, input: [{ type: "text", text: prompt }] };
      if (opts.reasoningEffort) turnParams.effort = opts.reasoningEffort;   // minimal|low|medium|high
      var tr = await request("turn/start", turnParams);
      turn.turnId = (tr && tr.turn && tr.turn.id) || null;
    } catch (e) {
      finishTurn(turn, { kind: "error", message: "turn/start failed: " + e });
      return { exitCode: -1 };
    }
    await donePromise;
    return { exitCode: 0 };
  }

  function shutdown() {
    try { if (S.proc) S.proc.kill(); } catch (e) {}
    S.proc = null; S.ready = null; S.turns = Object.create(null); S.activeThreads = null; S.pending = Object.create(null);
  }

  root.PRAAppServer = { runTurn: runTurn, shutdown: shutdown };
})(typeof globalThis !== "undefined" ? globalThis : this);

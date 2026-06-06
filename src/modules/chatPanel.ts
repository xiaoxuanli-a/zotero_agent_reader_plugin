// @ts-nocheck
/*
 * chatPanel.ts — the Zotero item-pane chat section (privileged chrome only).
 *
 * Registers ONE section via Zotero.ItemPaneManager.registerSection; it docks in
 * the reader tab's right pane (beside the PDF) and in the library item pane,
 * auto-scoped to the current item. Streams codex deltas straight into the live
 * `body` DOM node — no HTTP, no SSE.
 */
import * as PRARender from "./render";
import * as PRACodexDriver from "./codexDriver";
import * as PRAItemContext from "./itemContext";
import * as PRAStore from "./store";
import * as PRAChatService from "./chatService";

var SECTION_ID = null;
var PLUGIN_ID = null;
var ROOT_URI = null;

function prefs() {
  function g(k, d) {
    var v = Zotero.Prefs.get("extensions.paper-reading-agent." + k, true);
    return (v === undefined || v === null || v === "") ? d : v;
  }
  return {
    codexPath: g("codexPath", "") || undefined,
    model: g("model", "") || undefined,
    reasoningEffort: g("reasoningEffort", "") || undefined,   // minimal|low|medium|high — lower = faster, less deep
    timeoutSec: parseInt(g("timeoutSec", 600), 10) || 600,
    webSearch: g("webSearch", true) !== false,
    sandbox: "read-only",
  };
}

function el(doc, tag, css, text) {
  var e = doc.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}

// Full chat styling. Colors come from Zotero's own design tokens (so the panel
// is native-looking AND follows light/dark automatically), each with a fallback.
var PRA_CSS = [
  // layout
  ".pra-wrap{display:flex;flex-direction:column;gap:10px;padding:10px 8px 12px;font:13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:var(--fill-primary,#1d2129);}",
  // health banner → subtle pill with a status dot
  ".pra-banner{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;font-size:11px;padding:3px 10px;border-radius:999px;background:var(--fill-quinary,rgba(0,0,0,.05));color:var(--fill-secondary,#6b7280);max-width:100%;}",
  ".pra-banner::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor;flex:none;}",
  ".pra-banner.ok{color:var(--accent-green,#2a9d4a);}.pra-banner.err{color:var(--accent-red,#d23b3b);}",
  // messages
  ".pra-messages{display:flex;flex-direction:column;gap:16px;overflow-y:auto;max-height:56vh;padding:2px 1px;}",
  ".pra-row{display:flex;}.pra-row.user{justify-content:flex-end;}.pra-row.assistant{justify-content:flex-start;}",
  // user = accent bubble; assistant = clean full-width prose (premium, uses narrow pane well)
  ".pra-bubble{word-break:break-word;}",
  ".pra-bubble.user{max-width:86%;padding:8px 12px;border-radius:15px 15px 5px 15px;background:var(--accent-blue,#2563eb);color:var(--accent-white,#fff);white-space:pre-wrap;box-shadow:0 1px 2px rgba(0,0,0,.14);}",
  ".pra-bubble.assistant{max-width:100%;width:100%;white-space:pre-wrap;}",
  // blinking streaming caret
  ".pra-bubble.streaming::after{content:'\\2588';margin-left:1px;font-size:.9em;color:var(--accent-blue,#2563eb);animation:pra-blink 1.05s steps(1) infinite;}",
  "@keyframes pra-blink{50%{opacity:0;}}",
  // status line
  ".pra-status{display:flex;align-items:center;gap:6px;min-height:16px;font-size:11px;color:var(--fill-secondary,#888);}",
  // composer = a large card holding the textarea + a bottom bar with Send (codex/claude-code style)
  ".pra-composer{display:flex;flex-direction:column;gap:8px;border:1px solid var(--color-border,rgba(0,0,0,.16));border-radius:16px;background:var(--color-control,#fff);padding:11px 11px 9px 13px;transition:border-color .15s,box-shadow .15s;}",
  ".pra-composer:focus-within{border-color:var(--accent-blue,#2563eb);box-shadow:0 0 0 3px var(--accent-blue10,rgba(64,114,229,.15));}",
  ".pra-input{border:none;outline:none;background:transparent;resize:none;width:100%;min-height:30px;max-height:340px;padding:0;font:inherit;line-height:1.55;color:var(--fill-primary,#1d2129);}",
  ".pra-input::placeholder{color:var(--fill-tertiary,#9aa0a6);}",
  ".pra-input:disabled{opacity:.6;}",
  ".pra-bar{display:flex;justify-content:flex-end;align-items:center;}",
  ".pra-send{flex:none;height:34px;padding:0 20px;border:none;border-radius:10px;cursor:pointer;background:var(--accent-blue,#2563eb);color:var(--accent-white,#fff);font:inherit;font-weight:600;transition:filter .15s,opacity .15s;}",
  ".pra-send:hover{filter:brightness(1.07);}.pra-send:active{filter:brightness(.95);}.pra-send:disabled{opacity:.5;cursor:default;}",
  ".pra-send.stop{background:var(--accent-red,#d23b3b);}",
  // ---- markdown (assistant) ----
  ".pra-md>:first-child{margin-top:0;}.pra-md>:last-child{margin-bottom:0;}",
  ".pra-md p{margin:0 0 8px;}.pra-md ul,.pra-md ol{margin:6px 0;padding-left:22px;}.pra-md li{margin:2px 0;}",
  ".pra-md h1,.pra-md h2,.pra-md h3,.pra-md h4{margin:12px 0 6px;font-weight:650;line-height:1.3;}",
  ".pra-md h1{font-size:1.25em;}.pra-md h2{font-size:1.15em;}.pra-md h3{font-size:1.06em;}.pra-md h4{font-size:1em;}",
  ".pra-md pre{background:var(--fill-quinary,rgba(0,0,0,.05));border:1px solid var(--color-border,rgba(0,0,0,.08));padding:8px 10px;border-radius:9px;overflow-x:auto;margin:8px 0;}",
  ".pra-md code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;}",
  ".pra-md :not(pre)>code{background:var(--fill-quinary,rgba(0,0,0,.06));padding:1.5px 5px;border-radius:5px;}",
  ".pra-md blockquote{margin:8px 0;padding:2px 0 2px 12px;border-left:3px solid var(--accent-blue30,rgba(64,114,229,.3));color:var(--fill-secondary,#555);}",
  ".pra-md a{color:var(--accent-blue,#2563eb);text-decoration:none;}.pra-md a:hover{text-decoration:underline;}",
  // clickable PDF source citation [p.N]
  ".pra-cite{cursor:pointer;color:var(--accent-blue,#2563eb);border:1px solid var(--accent-blue30,rgba(64,114,229,.35));border-radius:5px;padding:0 4px;margin:0 1px;font-size:.82em;white-space:nowrap;}",
  ".pra-cite:hover{background:var(--accent-blue10,rgba(64,114,229,.13));}",
  ".pra-md table{border-collapse:collapse;margin:8px 0;font-size:.95em;}",
  ".pra-md th,.pra-md td{border:1px solid var(--color-border,rgba(0,0,0,.15));padding:4px 8px;}",
  ".pra-md th{background:var(--fill-quinary,rgba(0,0,0,.04));font-weight:600;}",
  ".pra-md hr{border:none;border-top:1px solid var(--color-border,rgba(0,0,0,.1));margin:10px 0;}",
  ".pra-md img{max-width:100%;}",
  ".pra-md .katex-display{margin:10px 0;overflow-x:auto;overflow-y:hidden;padding:2px 0;}",
].join("");

// Inject KaTeX's stylesheet + our chat CSS into the panel's OWN subtree (wrap).
// Putting them in our HTML subtree (NOT doc.head — which does not reliably apply
// in the Zotero item-pane document) is what makes the styles take effect.
function injectStyles(doc, wrap) {
  try {
    if (ROOT_URI) {
      var link = doc.createElement("link");
      link.rel = "stylesheet";
      link.href = ROOT_URI + "content/vendor/katex.min.css";
      wrap.appendChild(link);
    }
    var style = doc.createElement("style");
    style.textContent = PRA_CSS;
    wrap.appendChild(style);
  } catch (e) { try { Zotero.debug("[PaperReadingAgent] injectStyles: " + e); } catch (e2) {} }
}

// Jump the open PDF reader to a page (1-based) of the given attachment item.
function navigateToPage(attachmentID, page) {
  if (!attachmentID || !page) return;
  try {
    var R = Zotero.Reader;
    var loc = { pageIndex: page - 1 };           // Reader pageIndex is 0-based
    var r = (R && R._readers && R._readers.find)
      ? R._readers.find(function (x) { return x.itemID === attachmentID; })
      : null;
    if (r && r.navigate) r.navigate(loc);        // already open → navigate in place
    else if (R && R.open) R.open(attachmentID, loc); // else open/focus + navigate
  } catch (e) { try { Zotero.debug("[PaperReadingAgent] cite navigate: " + e); } catch (e2) {} }
}

// Render assistant text as Markdown+math HTML; fall back to plain text on any
// failure (never inject unsanitized HTML into the privileged node).
function setRich(bubble, text, attachmentID) {
  var html = null;
  try {
    var win = bubble.ownerDocument && bubble.ownerDocument.defaultView;
    if (PRARender && win) html = PRARender.render(text, win);
  } catch (e) { html = null; }
  if (html == null) { bubble.textContent = text || ""; return; }
  try {
    bubble.innerHTML = html;            // can throw in a strict (XHTML) item-pane doc on odd HTML
    bubble.classList.add("pra-md");
    bubble.style.whiteSpace = "normal";
  } catch (e) {
    try { Zotero.debug("[PaperReadingAgent] setRich innerHTML failed, falling back to text: " + e); } catch (e2) {}
    bubble.textContent = text || "";
    return;
  }
  try {
    var as = bubble.querySelectorAll("a[href]");
    for (var i = 0; i < as.length; i++) {
      (function (href) {
        // open links in the external browser, never navigate the item pane
        as[i].addEventListener("click", function (e) {
          e.preventDefault();
          try { Zotero.launchURL(href); } catch (e2) {}
        });
      })(as[i].getAttribute("href"));
    }
    var cites = bubble.querySelectorAll(".pra-cite");   // [p.N] → jump to that PDF page
    for (var k = 0; k < cites.length; k++) {
      (function (span) {
        span.addEventListener("click", function () {
          navigateToPage(attachmentID, parseInt(span.getAttribute("data-page"), 10));
        });
      })(cites[k]);
    }
  } catch (e) {}
}

function renderMessage(doc, container, msg, attachmentID) {
  var row = el(doc, "div"); row.className = "pra-row " + (msg.role === "user" ? "user" : "assistant");
  var bubble = el(doc, "div"); bubble.className = "pra-bubble " + (msg.role === "user" ? "user" : "assistant");
  if (msg.role === "assistant" && msg.content) setRich(bubble, msg.content, attachmentID);
  else bubble.textContent = msg.content || "";
  row.appendChild(bubble);
  container.appendChild(row);
  return bubble;
}

function buildSkeleton(doc, body) {
  body.textContent = "";
  var wrap = el(doc, "div"); wrap.className = "pra-wrap";
  injectStyles(doc, wrap);
  var banner = el(doc, "div"); banner.className = "pra-banner";
  var messages = el(doc, "div"); messages.className = "pra-messages";
  var status = el(doc, "div"); status.className = "pra-status";
  var composer = el(doc, "div"); composer.className = "pra-composer";
  var input = el(doc, "textarea"); input.className = "pra-input";
  input.setAttribute("rows", "4");
  input.setAttribute("placeholder", "Ask about this paper…   (Enter to send · Shift+Enter for a new line)");
  var bar = el(doc, "div"); bar.className = "pra-bar";
  var send = el(doc, "button"); send.className = "pra-send"; send.textContent = "Send";
  bar.appendChild(send);
  composer.append(input, bar);
  wrap.append(banner, messages, status, composer);
  body.append(wrap);
  return { banner: banner, messages: messages, status: status, input: input, send: send };
}

// ---- Session model ---------------------------------------------------------
// A turn (in-flight codex request + its streaming) is owned by a module-level
// SESSION keyed by the paper's attachment key — NOT by a panel mount. So when
// Zotero re-renders/destroys/recreates the item-pane section (on tab switch,
// clicking a citation that opens the reader, item change, scroll), the turn
// KEEPS RUNNING and the next mount RE-ATTACHES to it. All painting reads
// `session.view` (the current ui), so a re-mount just swaps the view.
var SESSIONS = Object.create(null);   // attachmentKey -> session
function getSession(key) {
  return SESSIONS[key] || (SESSIONS[key] = { key: key, ctx: null, conv: null, run: null, richId: 0, view: null });
}
function isBusy(session) { return !!(session.run && !session.run.finished); }

function setSending(session, busy) {
  var v = session.view; if (!v) return;
  v.ui.input.disabled = busy;
  v.ui.send.disabled = false;                 // stays clickable as a Stop button while busy
  v.ui.send.textContent = busy ? "Stop" : "Send";
  v.ui.send.classList.toggle("stop", busy);
}
function paintStatus(session) {
  var v = session.view, r = session.run;
  if (v && r && !r.finished) {
    v.ui.status.textContent = "⚙ " + r.lastActivity + " · " + Math.round((Date.now() - r.startedAt) / 1000) + "s";
  }
}
function renderAssistant(session) {           // render run.text into the CURRENT view's bubble
  var v = session.view, r = session.run;
  if (v && v.assistantBubble && r) { setRich(v.assistantBubble, r.text, v.attachmentID); v.ui.messages.scrollTop = v.ui.messages.scrollHeight; }
}
function scheduleRender(session) {            // ~16fps; setTimeout (not rAF, which pauses off-screen)
  if (session.richId) return;
  session.richId = setTimeout(function () { session.richId = 0; renderAssistant(session); }, 60);
}
function flushRender(session) {
  if (session.richId) { try { clearTimeout(session.richId); } catch (e) {} session.richId = 0; }
  renderAssistant(session);
}

function startTurn(session, content) {
  var run = session.run = { liveRef: {}, startedAt: Date.now(), lastActivity: "thinking…", finished: false, text: "", timer: 0 };
  setSending(session, true);
  paintStatus(session);
  run.timer = setInterval(function () { paintStatus(session); }, 1000);
  function endTurn(errMsg) {
    if (run.finished) return;
    run.finished = true;
    try { clearInterval(run.timer); } catch (e) {}
    flushRender(session);
    var v = session.view;
    if (v) {
      if (v.assistantBubble) v.assistantBubble.classList.remove("streaming");
      v.ui.status.textContent = errMsg ? ("⚠ " + errMsg) : "";
    }
    session.run = null;
    setSending(session, false);
  }
  var adapter = {
    onUser: function (m) { var v = session.view; if (v) { renderMessage(v.doc, v.ui.messages, m, v.attachmentID); v.ui.messages.scrollTop = v.ui.messages.scrollHeight; } },
    onAssistantStart: function (m) { var v = session.view; if (v) { v.assistantBubble = renderMessage(v.doc, v.ui.messages, m, v.attachmentID); v.assistantBubble.classList.add("streaming"); } },
    onAssistantUpdate: function (text) { run.text = text; scheduleRender(session); },
    onStatus: function (s) { run.lastActivity = String(s).slice(0, 120); paintStatus(session); },
    onDone: function () { endTurn(null); },
    onError: function (msg) { endTurn(msg); },
  };
  PRAChatService.runTurn(prefs(), session.ctx, session.conv, content, adapter, run.liveRef)
    .catch(function (e) { endTurn(String(e)); });
}

// (Re)build the panel for a given item and RE-ATTACH any running turn.
async function mount(body, item) {
  var doc = body.ownerDocument;
  var ui = buildSkeleton(doc, body);

  PRACodexDriver.healthcheck(prefs()).then(function (h) {
    ui.banner.textContent = h.ok
      ? ("codex ready · " + (h.version || ""))
      : ((h.error || "codex unavailable") + " — run `codex login` or set the codex path");
    ui.banner.classList.remove("ok", "err");
    ui.banner.classList.add(h.ok ? "ok" : "err");
  });

  if (!item) { ui.banner.textContent = "Select a paper."; ui.input.disabled = true; ui.send.disabled = true; return; }

  var ctx;
  try {
    ctx = await PRAItemContext.prepareWorkdir(item);
  } catch (e) {
    ui.status.textContent = "⚠ " + (e && e.message ? e.message : e);
    ui.input.disabled = true; ui.send.disabled = true;
    return;
  }

  var session = getSession(ctx.key);
  session.ctx = ctx;
  if (!session.conv) session.conv = await PRAStore.load(ctx.key);

  ui.messages.textContent = "";
  var lastBubble = null;
  session.conv.messages.forEach(function (m) {   // one bad message must NOT abort mount (else the input never gets wired)
    try { lastBubble = renderMessage(doc, ui.messages, m, ctx.attachmentID); }
    catch (e) { try { Zotero.debug("[PaperReadingAgent] renderMessage failed: " + e); } catch (e2) {} }
  });
  ui.messages.scrollTop = ui.messages.scrollHeight;

  session.view = { ui: ui, doc: doc, attachmentID: ctx.attachmentID, assistantBubble: null };

  if (isBusy(session)) {
    // last message is the in-flight assistant — re-attach to it
    session.view.assistantBubble = lastBubble;
    if (lastBubble) lastBubble.classList.add("streaming");
    setSending(session, true);
    flushRender(session);   // make sure the partial answer shows
    paintStatus(session);   // the (module-level) timer keeps ticking into this view
  } else {
    setSending(session, false);
  }

  function doSend() {
    var content = (ui.input.value || "").trim();
    try { Zotero.debug("[PaperReadingAgent] doSend len=" + content.length + " busy=" + isBusy(session) + " run=" + (session.run ? ("finished:" + session.run.finished) : "null") + " view=" + (!!session.view)); } catch (e) {}
    if (!content || isBusy(session)) return;
    ui.input.value = "";
    ui.input.style.height = "auto";
    try { startTurn(session, content); }
    catch (e) { try { Zotero.debug("[PaperReadingAgent] startTurn threw: " + e); } catch (e2) {} ui.status.textContent = "⚠ " + e; }
  }
  ui.send.addEventListener("click", function () {   // Send, or Stop (cancel) while a turn runs
    try { Zotero.debug("[PaperReadingAgent] send-click busy=" + isBusy(session)); } catch (e) {}
    if (isBusy(session)) { try { if (session.run && session.run.liveRef && session.run.liveRef.kill) session.run.liveRef.kill(); } catch (e) {} }
    else doSend();
  });
  ui.input.addEventListener("keydown", function (e) {
    // Do NOT hijack Enter while an IME (e.g. Chinese pinyin) is composing.
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); doSend(); }
  });
  ui.input.addEventListener("input", function () {  // auto-grow
    ui.input.style.height = "auto";
    ui.input.style.height = Math.min(340, ui.input.scrollHeight) + "px";
  });
}

export function register(arg) {
  PLUGIN_ID = arg && arg.pluginID;
  ROOT_URI = arg && arg.rootURI;
  try {
    // Zotero 7–9 require header/sidenav to carry { l10nID, icon } (NOT a plain
    // `label` — the validator rejects unknown keys). l10nID resolves against
    // the plugin's FTL (addon/locale/en-US/addon.ftl → paper-reading-agent-*),
    // injected into each window in hooks.ts. Icons are background-images themed
    // via -moz-context-properties, so the SVGs use fill="context-fill".
    SECTION_ID = Zotero.ItemPaneManager.registerSection({
      paneID: "paper-reading-agent-chat",
      pluginID: PLUGIN_ID,
      header: { l10nID: "paper-reading-agent-header", icon: ROOT_URI + "content/icon16.svg" },
      sidenav: { l10nID: "paper-reading-agent-sidenav", icon: ROOT_URI + "content/icon20.svg" },
      onRender: function () { /* skeleton built in onAsyncRender */ },
      onAsyncRender: async function (hooks) {
        try { await mount(hooks.body, hooks.item); }
        catch (e) { Zotero.debug("[PaperReadingAgent] render error: " + e); }
      },
      onItemChange: function (hooks) {
        try { mount(hooks.body, hooks.item); } catch (e) {}
        return true;
      },
      onDestroy: function () { /* keep any running turn alive across re-render; the next mount re-attaches. Runs are killed only by Stop or plugin shutdown (appServer.shutdown). */ },
    });
    Zotero.debug("[PaperReadingAgent] section registered: " + SECTION_ID);
  } catch (e) {
    Zotero.debug("[PaperReadingAgent] registerSection FAILED: " + e);
  }
}

export function unregister() {
  try { if (SECTION_ID) Zotero.ItemPaneManager.unregisterSection(SECTION_ID); } catch (e) {}
  SECTION_ID = null;
}

export function dump() {   // debug: inspect per-paper session state from Run JavaScript
  var out = {};
  try {
    Object.keys(SESSIONS).forEach(function (k) {
      var s = SESSIONS[k];
      out[k] = {
        busy: isBusy(s),
        run: s.run ? { finished: s.run.finished, lastActivity: s.run.lastActivity, textLen: (s.run.text || "").length } : null,
        msgs: s.conv ? s.conv.messages.length : -1,
        hasView: !!s.view,
      };
    });
  } catch (e) { out.error = String(e); }
  return out;
}

// reachable from Run JavaScript for debugging (unchanged handle from v0.1.0)
try { Zotero.PaperReadingAgent = { register: register, unregister: unregister, dump: dump }; } catch (e) {}

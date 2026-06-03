/*
 * bootstrap.js — Zotero 7 bootstrapped-plugin lifecycle.
 * Loads the content modules into this scope and registers the chat section.
 */

/* globals Zotero, Services, ChromeUtils */

// Third-party render libs (attach globals: marked, DOMPurify, katex). Loaded
// before our modules; a failure here just degrades chat to plain text.
var PRA_VENDOR = [
  "vendor/marked.min.js",
  "vendor/purify.min.js",
  "vendor/katex.min.js",
];

var PRA_MODULES = [
  "eventMapper.js",
  "codexDriver.js",
  "appServer.js",
  "itemContext.js",
  "store.js",
  "chatService.js",
  "render.js",
  "chatPanel.js",
];

var PRA_FTL = "paper-reading-agent.ftl";

function log(msg) {
  try { Zotero.debug("[PaperReadingAgent] " + msg); } catch (e) {}
}

// The section header/sidenav use Fluent l10nIDs. Zotero auto-registers the
// plugin's locale/*/*.ftl into L10nRegistry, but each window still needs a
// <link rel="localization"> so its document.l10n can resolve the IDs. Mirror
// Zotero's own make-it-red sample: inject on startup + onMainWindowLoad.
function injectFTL(win) {
  try {
    if (win && win.MozXULElement && win.MozXULElement.insertFTLIfNeeded) {
      win.MozXULElement.insertFTLIfNeeded(PRA_FTL);
    }
  } catch (e) { log("injectFTL failed: " + e); }
}

function removeFTL(win) {
  try {
    var link = win && win.document &&
      win.document.querySelector('link[href="' + PRA_FTL + '"]');
    if (link) link.remove();
  } catch (e) {}
}

function eachMainWindow(fn) {
  try {
    var wins = Zotero.getMainWindows ? Zotero.getMainWindows() : [];
    for (var i = 0; i < wins.length; i++) fn(wins[i]);
  } catch (e) {}
}

async function startup({ id, version, rootURI }) {
  await Zotero.initializationPromise;
  for (var v = 0; v < PRA_VENDOR.length; v++) {
    try { Services.scriptloader.loadSubScript(rootURI + "content/" + PRA_VENDOR[v]); }
    catch (e) { log("vendor load failed (" + PRA_VENDOR[v] + "): " + e); } // degrade to plain text
  }
  for (var i = 0; i < PRA_MODULES.length; i++) {
    Services.scriptloader.loadSubScript(rootURI + "content/" + PRA_MODULES[i]);
  }
  try {
    globalThis.PRAChatPanel.register({ pluginID: id, rootURI: rootURI });
    eachMainWindow(injectFTL); // windows already open when the plugin starts
    log("started v" + version);
  } catch (e) {
    log("startup register failed: " + e);
  }
}

function shutdown() {
  try { if (globalThis.PRAChatPanel) globalThis.PRAChatPanel.unregister(); } catch (e) {}
  try { if (globalThis.PRAAppServer) globalThis.PRAAppServer.shutdown(); } catch (e) {} // kill the persistent codex app-server
  eachMainWindow(removeFTL);
  // drop references so the modules can be GC'd
  [
    "PRAEventMapper", "PRACodexDriver", "PRAAppServer", "PRAItemContext",
    "PRAStore", "PRAChatService", "PRARender", "PRAChatPanel",
    "marked", "DOMPurify", "katex",
  ].forEach(function (k) { try { delete globalThis[k]; } catch (e) {} });
}

function install() {}
function uninstall() {}
function onMainWindowLoad({ window }) { injectFTL(window); }    // windows opened later
function onMainWindowUnload({ window }) { removeFTL(window); }

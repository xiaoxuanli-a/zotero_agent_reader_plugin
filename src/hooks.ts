// @ts-nocheck
/*
 * hooks.ts — Paper Reading Agent lifecycle (dispatched from addon/bootstrap.js
 * via the bundled src/index.ts). Mirrors the old bootstrap.js startup/shutdown:
 *   startup  → register the item-pane chat section + inject the FTL into windows
 *   shutdown → unregister the section, KILL the persistent codex app-server,
 *              remove the FTL
 */
import { config } from "../package.json";
import {
  register as registerChatSection,
  unregister as unregisterChatSection,
} from "./modules/chatPanel";
import { shutdown as appServerShutdown } from "./modules/appServer";

// scaffold prefixes the FTL file name + message IDs with the addon ref, so the
// built file is `paper-reading-agent-addon.ftl`.
const FTL_FILE = `${config.addonRef}-addon.ftl`;

// The section header/sidenav use Fluent l10nIDs. Zotero auto-registers the
// plugin's locale/*/*.ftl into L10nRegistry, but each window still needs a
// <link rel="localization"> so its document.l10n can resolve the IDs. Mirror
// Zotero's make-it-red sample: inject on startup + onMainWindowLoad.
function injectFTL(win) {
  try {
    if (win && win.MozXULElement && win.MozXULElement.insertFTLIfNeeded) {
      win.MozXULElement.insertFTLIfNeeded(FTL_FILE);
    }
  } catch (e) {
    Zotero.debug("[PaperReadingAgent] injectFTL failed: " + e);
  }
}

function removeFTL(win) {
  try {
    const link =
      win &&
      win.document &&
      win.document.querySelector('link[href="' + FTL_FILE + '"]');
    if (link) link.remove();
  } catch (e) {
    /* ignore */
  }
}

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  registerChatSection({ pluginID: config.addonID, rootURI });

  // windows already open when the plugin starts
  Zotero.getMainWindows().forEach((win) => injectFTL(win));

  addon.data.initialized = true;
}

async function onMainWindowLoad(win) {
  injectFTL(win); // windows opened later
}

async function onMainWindowUnload(win) {
  removeFTL(win);
}

function onShutdown() {
  try {
    unregisterChatSection();
  } catch (e) {
    /* ignore */
  }
  try {
    appServerShutdown(); // kill the persistent codex app-server
  } catch (e) {
    /* ignore */
  }
  Zotero.getMainWindows().forEach((win) => removeFTL(win));

  addon.data.alive = false;
  delete Zotero[config.addonInstance];
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
};

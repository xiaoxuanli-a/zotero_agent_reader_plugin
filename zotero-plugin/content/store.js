/*
 * store.js — per-item conversation persistence (Zotero / privileged chrome only).
 *
 * One JSON file per Zotero attachment key under the plugin data dir, mirroring
 * the standalone app's conversations/messages model:
 *   { item_key, codex_session_id, messages: [{ role, content }] }
 *
 * JSON-on-disk is the v0 choice for simplicity and high confidence it works when
 * loaded; it can move to a plugin-owned sqlite (Zotero.DBConnection) later
 * without touching callers.
 */
(function (root) {
  "use strict";

  function convDir() {
    return PathUtils.join(Zotero.DataDirectory.dir, "paper-reading-agent", "conversations");
  }
  function convPath(key) {
    return PathUtils.join(convDir(), key + ".json");
  }

  async function load(key) {
    var fresh = { item_key: key, codex_session_id: null, messages: [] };
    try {
      var p = convPath(key);
      if (!(await IOUtils.exists(p))) return fresh;
      var text = await IOUtils.readUTF8(p);
      var obj = JSON.parse(text);
      if (!obj.messages) obj.messages = [];
      obj.item_key = key;
      return obj;
    } catch (e) {
      return fresh;
    }
  }

  async function save(conv) {
    try {
      await IOUtils.makeDirectory(convDir(), { ignoreExisting: true, createAncestors: true });
      await IOUtils.writeUTF8(convPath(conv.item_key), JSON.stringify(conv));
    } catch (e) {
      Zotero.debug("[PaperReadingAgent] store.save failed: " + e);
    }
  }

  root.PRAStore = { load: load, save: save };
})(typeof globalThis !== "undefined" ? globalThis : this);

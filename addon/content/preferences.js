/* eslint-disable no-undef */
/*
 * preferences.js — runs in the Zotero preferences window when the Paper Reading
 * Agent pane loads (registered via Zotero.PreferencePanes.register({scripts})).
 * Most controls auto-bind via a preference key; this only (a) shows the active
 * backend's group and hides the other, and (b) runs the "Test connection" button.
 * Degrades gracefully: if anything isn't ready, both groups simply stay visible.
 */
var PaperReadingAgentPrefs = {
  PREFIX: "extensions.paper-reading-agent.",
  _wired: false,

  sync: function () {
    try {
      var backend = Zotero.Prefs.get(this.PREFIX + "backend", true) || "codex";
      var codex = document.getElementById("pra-codex-group");
      var claude = document.getElementById("pra-claude-group");
      if (codex) codex.hidden = backend !== "codex";
      if (claude) claude.hidden = backend !== "claude";
    } catch (e) {
      /* leave both visible */
    }
  },

  test: async function () {
    var status = document.getElementById("pra-test-status");
    function setStatus(s) {
      if (status) status.value = s;
    }
    setStatus("Testing…");
    try {
      var api = Zotero.PaperReadingAgent;
      if (!api || !api.healthcheck) {
        setStatus("plugin not ready — open a paper first");
        return;
      }
      var h = await api.healthcheck();
      setStatus(
        h && h.ok
          ? "✓ " + (h.label || "backend") + " ready · " + (h.version || "")
          : "✗ " + ((h && h.error) || "unavailable"),
      );
    } catch (e) {
      setStatus("✗ " + e);
    }
  },

  // attach listeners (once) + set initial visibility. Safe to call repeatedly.
  init: function () {
    try {
      var self = this;
      var backend = document.getElementById("pra-backend");
      if (backend && !self._wired) {
        backend.addEventListener("command", function () {
          self.sync();
        });
        self._wired = true;
      }
      var testBtn = document.getElementById("pra-test");
      if (testBtn && !testBtn._praWired) {
        testBtn.addEventListener("command", function () {
          self.test();
        });
        testBtn._praWired = true;
      }
      self.sync();
    } catch (e) {
      /* ignore */
    }
  },
};

// The pane DOM may not be fully attached the instant this script runs, so try
// now and again on the next tick.
PaperReadingAgentPrefs.init();
if (typeof setTimeout === "function") {
  setTimeout(function () {
    PaperReadingAgentPrefs.init();
  }, 0);
}

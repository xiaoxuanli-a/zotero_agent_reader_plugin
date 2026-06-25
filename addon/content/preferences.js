/* eslint-disable no-undef */
/*
 * preferences.js — runs in the Zotero preferences window when the Paper Reading
 * Agent pane loads (registered via Zotero.PreferencePanes.register({scripts})).
 * Most controls auto-bind via a preference key; this only (a) shows the active
 * backend's group and hides the other, (b) runs the "Test connection" button, and
 * (c) runs the on-demand "Check for updates" / "Install update" buttons.
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

  // On-demand update check (no fixed schedule — runs when the user clicks).
  checkUpdates: async function () {
    var status = document.getElementById("pra-update-status");
    var installBtn = document.getElementById("pra-install-update");
    function setStatus(s) { if (status) status.value = s; }
    if (installBtn) installBtn.hidden = true;
    setStatus("Checking…");
    try {
      var api = Zotero.PaperReadingAgent;
      if (!api || !api.checkForUpdates) { setStatus("plugin not ready — open a paper first"); return; }
      var r = await api.checkForUpdates();
      if (r && r.status === "available") {
        setStatus("Update available: " + (r.available || "?") + " (current " + (r.current || "?") + ")");
        if (installBtn) installBtn.hidden = false;
      } else if (r && r.status === "latest") {
        setStatus("✓ You're on the latest version (" + (r.current || "") + ")");
      } else {
        setStatus("✗ " + ((r && r.error) || "check failed"));
      }
    } catch (e) {
      setStatus("✗ " + e);
    }
  },

  // Install the version found by the last check; applies on the next restart.
  installUpdate: async function () {
    var status = document.getElementById("pra-update-status");
    var installBtn = document.getElementById("pra-install-update");
    function setStatus(s) { if (status) status.value = s; }
    setStatus("Installing…");
    if (installBtn) installBtn.disabled = true;
    try {
      var api = Zotero.PaperReadingAgent;
      if (!api || !api.installUpdate) { setStatus("plugin not ready"); if (installBtn) installBtn.disabled = false; return; }
      var r = await api.installUpdate();
      if (r && r.ok) {
        setStatus("✓ Installed " + (r.version || "") + " — restart Zotero to apply.");
        if (installBtn) installBtn.hidden = true;
      } else {
        setStatus("✗ " + ((r && r.error) || "install failed"));
        if (installBtn) installBtn.disabled = false;
      }
    } catch (e) {
      setStatus("✗ " + e);
      if (installBtn) installBtn.disabled = false;
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
      var checkBtn = document.getElementById("pra-check-update");
      if (checkBtn && !checkBtn._praWired) {
        checkBtn.addEventListener("command", function () {
          self.checkUpdates();
        });
        checkBtn._praWired = true;
      }
      var installBtn = document.getElementById("pra-install-update");
      if (installBtn && !installBtn._praWired) {
        installBtn.addEventListener("command", function () {
          self.installUpdate();
        });
        installBtn._praWired = true;
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

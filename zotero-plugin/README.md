# Paper Reading Agent — Zotero plugin

Chat with the paper you have open in Zotero. A **"Codex Chat"** panel docks in the
right-hand item pane (beside the PDF in the reader). The "agent" is a **local
`codex` CLI** scoped to that paper — it reads the PDF (via `pdftotext`), can search
the web, and answers with **live token-by-token streaming**, **Markdown + math
(KaTeX)** rendering, and **clickable `[p.N]` citations that jump the PDF reader to
that page**. One codex conversation per paper, with multi-turn memory.

## Features

- **Per-paper chat** docked in the item pane, auto-scoped to the open item.
- **Real token streaming** — driven by a persistent `codex app-server` (stdio
  JSON-RPC), so answers stream in word-by-word, not all-at-once.
- **Markdown + LaTeX math** rendering of answers (bundled `marked` + `KaTeX`,
  sanitized with `DOMPurify`), coalesced to the display refresh rate.
- **Source-of-truth citations** — the agent appends `[p.N "quote"]` after key
  claims; click the `[p.N]` pill to jump the Zotero PDF reader to that page.
- **Theme-aware UI** — built on Zotero's own design tokens, so it follows
  light/dark; right-aligned user bubbles, a large composer, a streaming caret, an
  elapsed timer, and a **Stop** button to cancel a running turn.
- **Read-only & local** — codex runs `--sandbox read-only` (it never writes your
  files); it uses your own `codex login`, with no cloud backend.

## Prerequisites

- **Zotero 9** (desktop). Developed and verified on **Zotero 9.0.4**.
- **Codex CLI** (`@openai/codex`, ≥ 0.130), installed and logged in:
  ```bash
  npm install -g @openai/codex
  codex login
  ```
- **poppler / `pdftotext`** on your machine (the agent reads the PDF with it):
  `brew install poppler` (macOS) / `apt install poppler-utils` (Linux) /
  `choco install poppler` (Windows).

## Install

1. Build or download `paper-reading-agent.xpi` (see *Build*).
2. In Zotero: **Tools → Plugins → ⚙ (gear) → Install Plugin From File…** → pick
   the `.xpi`, then restart Zotero.
3. Open a paper's PDF (or select an item with a PDF). A **"Codex Chat"** section
   appears in the right item pane. Ask a question.

## Configuration

There is no preferences UI yet — set these via **Settings → Advanced → Config
Editor** (keys are created on first use):

| Pref (`extensions.paper-reading-agent.…`) | Default | Meaning |
|---|---|---|
| `codexPath` | *(empty → search PATH)* | Absolute path to `codex`. **Set this** if the panel says "codex not found" — a GUI-launched Zotero often doesn't inherit your shell PATH. Find it with `which codex`. (On a standard Homebrew mac the plugin already prepends `/opt/homebrew/bin` etc., so this is usually optional.) |
| `model` | *(codex config)* | Override the codex model. |
| `timeoutSec` | `600` | Per-turn wall-clock timeout. |
| `webSearch` | `true` | Set `false` to disable codex web search. |

The panel shows a health banner (`codex ready · codex-cli 0.130.0`, or an error
with guidance).

## How it works

- **UI** — `Zotero.ItemPaneManager.registerSection` adds the panel, auto-scoped to
  the current item (`onItemChange` re-scopes on a paper switch). Answers render as
  Markdown + math; `[p.N]` citations become clickable pills that call
  `Zotero.Reader.navigate({ pageIndex })`.
- **Scoping** — on each render the plugin resolves the attachment's on-disk path
  (`getFilePathAsync`) and writes a per-item working dir with an `AGENTS.md` that
  points codex at that PDF and asks it to cite pages (`[p.N "verbatim quote"]`).
- **Driving codex (streaming)** — the plugin spawns **one persistent
  `codex app-server`** via Mozilla's `Subprocess.sys.mjs` and speaks line-delimited
  JSON-RPC 2.0: `initialize` → `thread/start { cwd, sandbox:"read-only",
  approvalPolicy:"never" }` (one thread per paper; `thread/resume` across sessions)
  → `turn/start { threadId, input }`. It consumes `item/agentMessage/delta` (the
  **token stream**), `item/started` (tool/command chips), and `turn/completed`,
  maps them to a backend-neutral `AgentEvent` vocabulary, and streams text into the
  panel live. The **Stop** button sends `turn/interrupt`.
- **Persistence** — one JSON file per item under
  `<Zotero data dir>/paper-reading-agent/conversations/<attachmentKey>.json`,
  holding the messages and the codex thread id (`codex_session_id`) for resume.
- The older `codex exec --json` path (`codexDriver.js`) is retained only for the
  startup `codex --version` health check.

## Verification status (read me)

- **Runs on real Zotero 9.0.4** — install, the item-pane section (l10n + icon),
  app-server token streaming, Markdown/math rendering, and the themed UI are
  confirmed on a live Zotero 9.
- **The app-server protocol is codex `[experimental]`.** The plugin is pinned to
  the codex **0.130** shapes (`thread/start`, `turn/start`,
  `item/agentMessage/delta`, …). A codex upgrade can change these and break
  streaming — re-verify on upgrade, and regenerate the schema with
  `codex app-server generate-json-schema --out <dir>`.
- **PDF citation jump** relies on `Zotero.Reader.navigate` / `Zotero.Reader.open`.
  The citation contract lives in the per-item `AGENTS.md`; because codex reads
  `AGENTS.md` at thread start, an `AGENTS.md` change only affects a **fresh** thread
  — delete a paper's `conversations/<key>.json` to pick it up.
- **`applications.zotero` MUST contain all three of `id`, `update_url`, and
  `strict_max_version`.** Zotero patches the Firefox manifest parser
  (`app/scripts/fetch_xulrunner`) to hard-require these; omitting any one makes the
  install fail as *"could not be installed … may be incompatible"* — which is
  really `ERROR_CORRUPT_FILE` (the manifest never becomes an addon), NOT a version
  mismatch. `update_url` is only checked for *presence* at local-xpi install (not
  fetched), so a placeholder HTTPS URL satisfies the check; point it at a real
  `updates.json` only when you want auto-update.
- `strict_max_version` is `10.9.9` (covers up to Zotero 10.x). Zotero releases a
  major every ~8 weeks and enforces this cap on stable builds, so raise it again
  when Zotero 11 ships.
- The header/sidenav use Fluent `l10nID`s + icons (Zotero's `registerSection`
  validator rejects a plain `label`); strings live in
  `locale/en-US/paper-reading-agent.ftl`, injected per window from `bootstrap.js`.
- Styles are injected into the panel's **own subtree** (not `doc.head`, which does
  not apply in the item-pane document). Errors are logged to **Help → Debug Output
  Logging** with the `[PaperReadingAgent]` prefix.

## Build

The plugin is plain JS — no build step. Repackage the `.xpi` (a zip with
`manifest.json` at the root) after edits:

```bash
cd zotero-plugin
python3 - <<'PY'
import zipfile, os
with zipfile.ZipFile("paper-reading-agent.xpi", "w", zipfile.ZIP_DEFLATED) as z:
    z.write("manifest.json"); z.write("bootstrap.js")
    # everything under content/ (modules, icons, vendor libs + KaTeX fonts) and
    # locale/ (Fluent) must ship in the xpi
    for base in ("content", "locale"):
        for root, _, files in os.walk(base):
            for fn in files:
                if fn == ".DS_Store":
                    continue
                z.write(os.path.join(root, fn))
PY
```

Unit-test the portable codex core: `node test/eventMapper.test.js`.

## Layout

```
zotero-plugin/
├── manifest.json            # Zotero 9 bootstrapped-extension manifest
├── bootstrap.js             # lifecycle: load modules/vendor, register section, inject FTL, kill app-server
├── content/
│   ├── eventMapper.js       # pure JSONL→AgentEvent (Node-tested; used by the exec health-check path)
│   ├── codexDriver.js       # `codex exec`/`--version` via Subprocess (now: health check + PATH augmentation)
│   ├── appServer.js         # persistent `codex app-server` JSON-RPC client → TOKEN streaming
│   ├── itemContext.js       # attachment path → workdir + AGENTS.md (incl. citation contract)
│   ├── store.js             # per-item JSON persistence (+ codex thread id)
│   ├── chatService.js       # persist → stream → persist orchestration
│   ├── render.js            # assistant Markdown + KaTeX math + [p.N] citations → sanitized HTML
│   ├── chatPanel.js         # registerSection + themed streaming chat UI + citation click → reader
│   ├── icon16.svg           # section header icon (context-fill themed)
│   ├── icon20.svg           # sidenav icon
│   └── vendor/              # bundled marked + DOMPurify + KaTeX (js/css/woff2)
├── locale/
│   └── en-US/
│       └── paper-reading-agent.ftl   # section header label + sidenav tooltip
└── test/
    ├── eventMapper.test.js   # node test/eventMapper.test.js
    └── fixtures/codex-0.130.jsonl
```

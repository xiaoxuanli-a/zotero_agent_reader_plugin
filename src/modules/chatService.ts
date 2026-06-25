// @ts-nocheck
/*
 * chatService.ts — orchestrate one chat turn (Zotero / privileged chrome only).
 *
 * Persist the user message, append an empty assistant message up front, drive the
 * codex turn, accumulate token deltas, and persist on done AND on error/teardown
 * so partial answers survive.
 *
 * `ui` adapter: { onUser(msg), onAssistantStart(msg), onAssistantUpdate(text),
 *                 onStatus(text), onDone(), onError(text) }
 */
import * as PRAStore from "./store";
import { getBackend } from "./backends";

export async function runTurn(opts, ctx, conv, content, images, ui, liveRef) {
  // images: [{ path, thumb }] — path is the on-disk file (sent to the backend),
  // thumb is a small data URL kept only for re-rendering the bubble after reload.
  var userMsg = { role: "user", content: content };
  if (images && images.length) userMsg.images = images;
  var assistant = { role: "assistant", content: "" };
  conv.messages.push(userMsg);
  conv.messages.push(assistant);
  await PRAStore.save(conv);
  if (ui.onUser) ui.onUser(userMsg);
  if (ui.onAssistantStart) ui.onAssistantStart(assistant);

  var terminal = false;

  // backends stream TOKEN deltas → concatenate (not join with blank lines)
  function persist() { PRAStore.save(conv); }

  var backend = getBackend(opts.backend);
  var handle = PRAStore.getSessionHandle(conv, backend.id);
  // let the backend read files outside the workdir (the PDF lives in Zotero's
  // storage tree); codex ignores opts.addDir, claude maps it to --add-dir.
  var runOpts = opts;
  try {
    runOpts = Object.assign({}, opts);
    if (ctx.pdfPath) runOpts.addDir = PathUtils.parent(ctx.pdfPath);
    if (images && images.length) runOpts.images = images.map(function (im) { return im.path; });
  } catch (e) { runOpts = opts; }

  await backend.runTurn(runOpts, ctx.workdir, handle, content, function (ev) {
    if (ev.kind === "thread_started") {
      if (ev.sessionId && PRAStore.setSessionHandle(conv, backend.id, ev.sessionId)) {
        PRAStore.save(conv);
      }
    } else if (ev.kind === "delta") {
      assistant.content += ev.text;
      if (ui.onAssistantUpdate) ui.onAssistantUpdate(assistant.content);
    } else if (ev.kind === "tool") {
      if (ui.onStatus) ui.onStatus((ev.toolName || "tool") + (ev.detail ? ": " + ev.detail : "…"));
    } else if (ev.kind === "done") {
      terminal = true;
      persist();
      if (ui.onDone) ui.onDone();
    } else if (ev.kind === "error") {
      terminal = true;
      persist();
      if (ui.onError) ui.onError(ev.message);
    }
  }, liveRef);

  if (!terminal) {
    persist();
    if (ui.onDone) ui.onDone();
  }
}

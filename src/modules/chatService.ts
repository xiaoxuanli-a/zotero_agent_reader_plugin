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
import * as PRAAppServer from "./appServer";

export async function runTurn(opts, ctx, conv, content, ui, liveRef) {
  var userMsg = { role: "user", content: content };
  var assistant = { role: "assistant", content: "" };
  conv.messages.push(userMsg);
  conv.messages.push(assistant);
  await PRAStore.save(conv);
  if (ui.onUser) ui.onUser(userMsg);
  if (ui.onAssistantStart) ui.onAssistantStart(assistant);

  var terminal = false;

  // app-server streams TOKEN deltas → concatenate (not join with blank lines)
  function persist() { PRAStore.save(conv); }

  await PRAAppServer.runTurn(opts, ctx.workdir, conv.codex_session_id, content, function (ev) {
    if (ev.kind === "thread_started") {
      if (ev.sessionId && !conv.codex_session_id) {
        conv.codex_session_id = ev.sessionId;
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

import { ThreadId, isDesktopIdeContext, type DesktopIdeContext } from "@synara/contracts";
import { useComposerDraftStore } from "../composerDraftStore";
import { createPastedTextDraft } from "./composerPastedText";

/** Explicit attachment only: never submit a turn, replace a prompt, or read secrets. */
export function appendDesktopIdeContext(value: DesktopIdeContext): void {
  if (!isDesktopIdeContext(value)) throw new Error("Invalid IDE context attachment.");
  const threadId = ThreadId.makeUnsafe(value.threadId);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const store = useComposerDraftStore.getState();
  if (value.kind === "terminal") {
    store.addTerminalContext(threadId, {
      id,
      threadId,
      createdAt,
      terminalId: "code-oss",
      terminalLabel: value.title,
      lineStart: 1,
      lineEnd: value.text.split("\n").length,
      text: value.text,
    });
  } else {
    store.addPastedTexts(threadId, [
      createPastedTextDraft({ id, createdAt, text: `${value.title}\n${value.text}` }),
    ]);
  }
}

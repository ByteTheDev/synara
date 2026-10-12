import "../../index.css";

import type { LegendListRef } from "@legendapp/list/react";
import { MessageId, type NativeApi, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { TimelineEntry } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";

const THREAD_ID = ThreadId.makeUnsafe("thread-visual-follow");
const NOW = "2026-10-12T12:00:00.000Z";
const VISUAL = {
  visualId: `vis_${"9".repeat(32)}`,
  title: "Growing chart",
  height: 120,
  byteLength: 300,
  sha256: "e".repeat(64),
};
// The page grows when the test asks, the way a chart grows once its data
// renders. It reports readiness through the only channel it has.
const GROWING_PAGE = `<div id="box" style="height:200px;background:var(--series-1)">chart body</div><script>
  addEventListener("message", (event) => {
    if (event.data && typeof event.data.grow === "number") box.style.height = event.data.grow + "px";
    // A reader's wheel over the page, as the page's own document sees it.
    if (event.data && event.data.wheel) dispatchEvent(new WheelEvent("wheel", { deltaY: event.data.wheel }));
  });
  addEventListener("load", () => parent.postMessage({ probe: "visual-ready" }, "*"));
</script>`;

const baseEntries: TimelineEntry[] = [
  {
    id: "entry-reply",
    kind: "message",
    createdAt: NOW,
    message: {
      id: MessageId.makeUnsafe("reply"),
      role: "assistant",
      text: "Measured every package.\n\n".repeat(40),
      createdAt: NOW,
      streaming: false,
    },
  },
  {
    id: "entry-visual",
    kind: "work",
    createdAt: "2026-10-12T12:00:01.000Z",
    entry: {
      id: "visual",
      createdAt: "2026-10-12T12:00:01.000Z",
      label: "Visual: Growing chart",
      tone: "info",
      activityKind: "visual.shown",
      inlineVisual: VISUAL,
    },
  },
];
/** The transcript as ChatView wires it: the real follow hook drives the list. */
function Transcript() {
  const listRef = useRef<LegendListRef | null>(null);
  const scroll = useChatTranscriptScroll({
    activeThreadId: THREAD_ID,
    legendListRef: listRef,
    timelineEntries: baseEntries,
    hasStreamingAssistantText: false,
    composerTranscriptInsetPx: 0,
    isInactiveSplitPane: false,
  });
  return (
    <div
      style={{ width: 640, height: 420 }}
      data-follow={scroll.isUserScrollDetached ? "detached" : "following"}
    >
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        listRef={listRef}
        threadId={THREAD_ID}
        followLiveOutput={!scroll.isUserScrollDetached}
        onIsAtEndChange={scroll.onIsAtEndChange}
        onMessagesScroll={scroll.onMessagesScrollBase}
        onMessagesWheel={scroll.onMessagesWheelBase}
        onMessagesPointerDown={scroll.onMessagesPointerDownBase}
        onMessagesPointerUp={scroll.onMessagesPointerUpBase}
        onEmbeddedScrollIntent={scroll.onEmbeddedScrollIntent}
        timelineEntries={baseEntries}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={NOW}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function mountTranscript() {
  vi.stubGlobal("nativeApi", {
    orchestration: {
      getInlineVisual: vi.fn(async () => ({ visualId: VISUAL.visualId, html: GROWING_PAGE })),
    },
  } as unknown as NativeApi);
  let ready = false;
  const onReady = (event: MessageEvent) => {
    if (event.data?.probe === "visual-ready") ready = true;
  };
  window.addEventListener("message", onReady);
  const client = new QueryClient();
  const screen = await render(
    <QueryClientProvider client={client}>
      <Transcript />
    </QueryClientProvider>,
  );
  cleanup = async () => {
    window.removeEventListener("message", onReady);
    await screen.unmount();
    client.clear();
  };
  await expect.poll(() => ready).toBe(true);
  const list = document.querySelector<HTMLElement>("[data-chat-scroll-container]")!;
  const frame = document.querySelector<HTMLIFrameElement>("iframe[data-inline-visual-frame]")!;
  await expect.poll(() => frame.getBoundingClientRect().height).toBe(200);
  const distanceFromEnd = () => list.scrollHeight - list.clientHeight - list.scrollTop;
  const grow = async (height: number) => {
    frame.contentWindow!.postMessage({ grow: height }, "*");
    await expect.poll(() => frame.getBoundingClientRect().height).toBe(height);
    // Let the list re-measure and settle before reading its position.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))),
    );
  };
  return { list, frame, distanceFromEnd, grow, followState };
}

const followState = () =>
  document.querySelector("[data-follow]")?.getAttribute("data-follow") ?? null;

it("keeps a reader at the end while a visual grows", async () => {
  const { distanceFromEnd, grow } = await mountTranscript();
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);

  await grow(900);

  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);
});

it("leaves a reader who scrolled up in place while a visual grows", async () => {
  const { list, distanceFromEnd, grow } = await mountTranscript();
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);

  // Not so far that the visual leaves the viewport: Chromium throttles
  // rendering in off-screen cross-origin frames, so they report no growth.
  await userEvent.wheel(list, { delta: { y: -120 } });
  await expect.poll(distanceFromEnd).toBeGreaterThan(60);
  const readingTop = list.scrollTop;
  const readingDistance = distanceFromEnd();

  await grow(900);

  // The reader stays put; the 700px of growth all lands below them.
  expect(list.scrollTop).toBeCloseTo(readingTop, 0);
  expect(distanceFromEnd()).toBeCloseTo(readingDistance + 700, 0);
});

it("releases follow when the reader scrolls up over a visual", async () => {
  const { list, frame, distanceFromEnd, grow, followState } = await mountTranscript();
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);
  expect(followState()).toBe("following");

  // A wheel over the page reaches only the frame's document (proven with real
  // input in InlineVisualFrame.browser.tsx); the browser chains the scroll to
  // the list. Reproduce both halves: the page's own wheel event and the scroll.
  frame.contentWindow!.postMessage({ wheel: -120 }, "*");
  list.scrollTop -= 120;
  await expect.poll(distanceFromEnd).toBeGreaterThan(60);
  // Detached exactly as a wheel on the transcript would leave it, so the
  // next message cannot snap the reader back.
  await expect.poll(followState).toBe("detached");
  const readingTop = list.scrollTop;

  await grow(900);

  expect(list.scrollTop).toBeCloseTo(readingTop, 0);
  expect(followState()).toBe("detached");
});

// FILE: useTimelineRowHeightHints.browser.tsx
// Purpose: Exercise persistent width ownership through the real React hook and
//          real browser layout. Reported item heights are controlled at the
//          LegendList callback boundary; viewport/row geometry is not mocked.
// Layer: Chat timeline browser regression tests

import type { LegendListRef } from "@legendapp/list/react";
import { MessageId } from "@synara/contracts";
import { useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { createTimelineRowHeightEstimator, estimateTimelineRowHeight } from "./timelineRowHeight.logic";
import { useTimelineRowHeightHints } from "./useTimelineRowHeightHints";

const LAYOUT = { rowWidthPx: 736, chatFontSizePx: 13 };
const noAdditionalPresentation = () => "";
type HeightHints = ReturnType<typeof useTimelineRowHeightHints>;
type ProbeState = { hints: HeightHints; node: HTMLDivElement };
type MessageRow = Extract<MessagesTimelineRow, { kind: "message" }>;

function messageRow(id: string): MessageRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-10-11T12:00:00.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text: "A settled plain-text answer for an independently measured row.",
      createdAt: "2026-10-11T12:00:00.000Z",
      streaming: false,
    },
    durationStart: "2026-10-11T12:00:00.000Z",
    showAssistantCopyButton: true,
    assistantCopyStreaming: false,
  };
}

function Probe({
  row,
  width,
  probeRef,
}: {
  row: MessageRow;
  width: number | null;
  probeRef: RefObject<ProbeState | null>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // The hook only consumes this public native-node accessor. The callback's
  // reported size is supplied explicitly below; no virtualizer result is claimed.
  const listRef = useMemo(
    () => ({ current: { getScrollableNode: () => scrollRef.current } as LegendListRef }),
    [],
  );
  const rows = useMemo(() => [row], [row]);
  const hints = useTimelineRowHeightHints(listRef, 13, rows, true, noAdditionalPresentation);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) throw new Error("missing mounted probe");
    probeRef.current = { hints, node };
    return () => { probeRef.current = null; };
  }, [hints, probeRef]);
  return (
    <div ref={scrollRef}>
      {width === null ? null : (
        <div data-timeline-row-kind="message" style={{ width, height: 30 }} />
      )}
    </div>
  );
}

async function mountProbe(row: MessageRow, width: number | null) {
  const probeRef: RefObject<ProbeState | null> = { current: null };
  const mounted = await render(<Probe row={row} width={width} probeRef={probeRef} />);
  const probe = probeRef.current;
  if (!probe) {
    await mounted.unmount();
    throw new Error("hook probe was not ready");
  }
  return { mounted, ...probe };
}

function estimate(row: MessageRow, width: number) {
  return createTimelineRowHeightEstimator(() => ({ ...LAYOUT, rowWidthPx: width }))(row);
}

describe("persistent row width ownership", () => {
  it("refuses unknown width and remembers only after a real row is measured", async () => {
    const row = messageRow("hook-unknown-then-measured");
    const { mounted, node, hints } = await mountProbe(row, null);
    try {
      hints.onItemSizeChanged({ itemKey: row.id, size: 1333 });
      expect(estimate(row, 736)).toBe(estimateTimelineRowHeight(row, LAYOUT));
      const element = document.createElement("div");
      element.dataset.timelineRowKind = "message";
      element.style.width = "420px";
      node.append(element);
      expect(element.getBoundingClientRect().width).toBe(420);
      hints.onItemSizeChanged({ itemKey: row.id, size: 1245 });
      expect(estimate(row, 420)).toBe(1245);
      expect(estimate(row, 736)).toBe(estimateTimelineRowHeight(row, LAYOUT));
    } finally {
      await mounted.unmount();
    }
  });

  it("pairs an item callback with current width before ResizeObserver can notify", async () => {
    const row = messageRow("hook-resize-before-observer");
    const { mounted, node, hints } = await mountProbe(row, 736);
    try {
      const element = node.querySelector<HTMLElement>("[data-timeline-row-kind]");
      if (!element) throw new Error("missing real row");
      expect(element.getBoundingClientRect().width).toBe(736);
      hints.onItemSizeChanged({ itemKey: row.id, size: 1111 });
      expect(estimate(row, 736)).toBe(1111);
      // No await occurs between mutation and callback: the list's item observer
      // can report before the viewport observer has delivered the changed width.
      element.style.width = "420px";
      hints.onItemSizeChanged({ itemKey: row.id, size: 2222 });
      expect(estimate(row, 736)).toBe(1111);
      expect(estimate(row, 420)).toBe(2222);
      expect(hints.getEstimatedItemSize(row)).toBe(2222);
    } finally {
      await mounted.unmount();
    }
  });

  it("refuses a late item size after its current row disappears", async () => {
    const row = messageRow("hook-lost-current-row");
    const { mounted, node, hints } = await mountProbe(row, 736);
    try {
      hints.onItemSizeChanged({ itemKey: row.id, size: 1111 });
      expect(estimate(row, 736)).toBe(1111);
      node.replaceChildren();
      hints.onItemSizeChanged({ itemKey: row.id, size: 7777 });
      expect(estimate(row, 736)).toBe(1111);
      expect(hints.getEstimatedItemSize(row)).toBe(estimateTimelineRowHeight(row, LAYOUT));
    } finally {
      await mounted.unmount();
    }
  });
});

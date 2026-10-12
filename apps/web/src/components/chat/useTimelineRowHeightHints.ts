// FILE: useTimelineRowHeightHints.ts
// Purpose: Feed the transcript virtualizer per-row size hints and remember the
//          heights it measures, so unrendered history is laid out close to its
//          real size and revisited chats open at their exact geometry.
// Layer: React hooks (chat timeline)
// Exports: useTimelineRowHeightHints

import type { LegendListRef } from "@legendapp/list/react";
import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

import {
  DEFAULT_TIMELINE_ROW_WIDTH_PX,
  createTimelineRowHeightEstimator,
  rememberTimelineRowHeight,
} from "./timelineRowHeight.logic";

export function useTimelineRowHeightHints(
  listRef: RefObject<LegendListRef | null>,
  chatFontSizePx: number,
) {
  const rowWidthPxRef = useRef(DEFAULT_TIMELINE_ROW_WIDTH_PX);
  const rowWidthMeasuredRef = useRef(false);

  // Reads one rendered row. Callers run right after layout (resize callbacks and the
  // list's own measurement pass), so this does not force an extra layout.
  const measureRowWidth = useCallback(() => {
    const node: unknown = listRef.current?.getScrollableNode?.();
    if (!(node instanceof HTMLElement)) return;
    const width =
      node.querySelector<HTMLElement>("[data-timeline-row-kind]")?.getBoundingClientRect().width ??
      0;
    if (width > 0) {
      rowWidthPxRef.current = width;
      rowWidthMeasuredRef.current = true;
    }
  }, [listRef]);

  useLayoutEffect(() => {
    const node: unknown = listRef.current?.getScrollableNode?.();
    if (!(node instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureRowWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, [listRef, measureRowWidth]);

  const getEstimatedItemSize = useMemo(
    () =>
      createTimelineRowHeightEstimator(() => ({
        rowWidthPx: rowWidthPxRef.current,
        chatFontSizePx,
      })),
    [chatFontSizePx],
  );

  const onItemSizeChanged = useCallback(
    ({ itemKey, size }: { itemKey: string; size: number }) => {
      if (!rowWidthMeasuredRef.current) measureRowWidth();
      rememberTimelineRowHeight(
        itemKey,
        { rowWidthPx: rowWidthPxRef.current, chatFontSizePx },
        size,
      );
    },
    [chatFontSizePx, measureRowWidth],
  );

  return { getEstimatedItemSize, onItemSizeChanged };
}

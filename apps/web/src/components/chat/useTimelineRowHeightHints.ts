// FILE: useTimelineRowHeightHints.ts
// Purpose: Feed the transcript virtualizer per-row size hints and remember the
//          heights it measures, so unrendered history is laid out close to its
//          real size and revisited chats open at their exact geometry.
// Layer: React hooks (chat timeline)
// Exports: useTimelineRowHeightHints

import type { LegendListRef } from "@legendapp/list/react";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

import {
  DEFAULT_TIMELINE_ROW_WIDTH_PX,
  createTimelineRowHeightEstimator,
  rememberTimelineRowHeight,
} from "./timelineRowHeight.logic";

export function useTimelineRowHeightHints(
  listRef: RefObject<LegendListRef | null>,
  chatFontSizePx: number,
  rows: readonly MessagesTimelineRow[],
  enabled: boolean,
  getPresentationKey: (row: MessagesTimelineRow) => string,
) {
  const rowsById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const rowWidthPxRef = useRef(DEFAULT_TIMELINE_ROW_WIDTH_PX);
  const rowWidthMeasuredRef = useRef(false);

  // Reads one rendered row. Callers run right after layout (resize callbacks and the
  // list's own measurement pass), so this does not force an extra layout.
  const measureRowWidth = useCallback(() => {
    const node: unknown = listRef.current?.getScrollableNode?.();
    if (!(node instanceof HTMLElement)) {
      rowWidthMeasuredRef.current = false;
      return null;
    }
    const width =
      node.querySelector<HTMLElement>("[data-timeline-row-kind]")?.getBoundingClientRect().width ??
      0;
    if (!Number.isFinite(width) || width <= 0) {
      rowWidthMeasuredRef.current = false;
      return null;
    }
    rowWidthPxRef.current = width;
    rowWidthMeasuredRef.current = true;
    return width;
  }, [listRef]);

  useLayoutEffect(() => {
    const node: unknown = listRef.current?.getScrollableNode?.();
    measureRowWidth();
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
      }), enabled, () => rowWidthMeasuredRef.current, getPresentationKey),
    [chatFontSizePx, enabled, getPresentationKey],
  );

  const onItemSizeChanged = useCallback(
    ({ itemKey, size }: { itemKey: string; size: number }) => {
      // Item and viewport observers may run in either order after a resize. Pair
      // this height with the current rendered width, never the previous callback.
      const width = measureRowWidth();
      const row = rowsById.get(itemKey);
      if (width === null || !row) return;
      rememberTimelineRowHeight(
        itemKey,
        { rowWidthPx: width, chatFontSizePx },
        size,
        row,
        enabled,
        getPresentationKey(row),
      );
    },
    [chatFontSizePx, measureRowWidth, rowsById, enabled, getPresentationKey],
  );

  return { getEstimatedItemSize, onItemSizeChanged };
}

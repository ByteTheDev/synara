// FILE: useSidebarThreadOrderHold.ts
// Purpose: Hold the sidebar thread order while the user is aiming at it, so a
//          row never moves between pointing at a chat and clicking it.
// Layer: Web hook
// Exports: useIsPointerWithin, useHeldSidebarThreadSortKeys

import { useEffect, useMemo, useState } from "react";

import type { SidebarThreadSortOrder } from "../appSettings";
import {
  getSidebarThreadSortKey,
  type SidebarThreadSortInput,
  type SidebarThreadSortKey,
} from "../components/Sidebar.logic";
import { isEditableEventTarget } from "../lib/editableEventTarget";
import { useStableValue } from "./useStableValue";

/**
 * Whether a mouse or pen pointer is over `element`. Tracked from document-level
 * pointermove so the answer stays right when the node under the pointer
 * unmounts (a popup closing), where enter/leave events never fire. Typing into
 * a field outside the element, or leaving the window, counts as leaving until
 * the pointer moves again, so a pointer resting on the sidebar while the user
 * writes in the composer holds nothing. Modifier keys alone don't release, so
 * a Cmd/Shift-click still lands on the row the user aimed at. Touch is
 * ignored: a tap has no hover phase to protect.
 */
export function useIsPointerWithin(element: HTMLElement | null): boolean {
  const [within, setWithin] = useState(false);

  useEffect(() => {
    if (!element) return;
    let current = false;
    const update = (next: boolean) => {
      if (next === current) return;
      current = next;
      setWithin(next);
    };
    const isInside = (target: EventTarget | null) =>
      target instanceof Node && element.contains(target);
    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      update(isInside(event.target));
    };
    const handlePointerOut = (event: PointerEvent) => {
      // A null relatedTarget means the pointer left the window.
      if (event.relatedTarget === null) update(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event) && !isInside(event.target)) update(false);
    };
    const handleBlur = () => update(false);
    const options = { capture: true, passive: true } as const;
    document.addEventListener("pointermove", handlePointerMove, options);
    document.addEventListener("pointerout", handlePointerOut, options);
    document.addEventListener("keydown", handleKeyDown, options);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove, options);
      document.removeEventListener("pointerout", handlePointerOut, options);
      document.removeEventListener("keydown", handleKeyDown, options);
      window.removeEventListener("blur", handleBlur);
      setWithin(false);
    };
  }, [element]);

  return element !== null && within;
}

/**
 * Sort keys for every sidebar thread, frozen while `hold` is true. Pass the
 * result to sortThreadsForSidebar as `heldKeys`: threads keep the position
 * they had when the hold began (opening an unread chat or a chat starting work
 * no longer reshuffles the rows under the pointer), new threads still slot in
 * by their live key, and the list settles once the hold ends. Changing the
 * sort settings always applies immediately.
 */
export function useHeldSidebarThreadSortKeys(input: {
  threads: ReadonlyArray<{ id: string } & SidebarThreadSortInput>;
  sortOrder: SidebarThreadSortOrder;
  attentionFirst: boolean;
  hold: boolean;
}): ReadonlyMap<string, SidebarThreadSortKey> {
  const { threads, sortOrder, attentionFirst, hold } = input;
  const liveKeys = useMemo(
    () => ({
      sortOrder,
      attentionFirst,
      byId: new Map(
        threads.map((thread) => [
          thread.id,
          getSidebarThreadSortKey(thread, sortOrder, attentionFirst),
        ]),
      ),
    }),
    [attentionFirst, sortOrder, threads],
  );
  return useStableValue(
    liveKeys,
    (held, live) =>
      hold && held.sortOrder === live.sortOrder && held.attentionFirst === live.attentionFirst,
  ).byId;
}

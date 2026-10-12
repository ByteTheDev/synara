// FILE: useSidebarThreadOrderHold.browser.tsx
// Purpose: Verifies the sidebar order holds while the pointer is over the list
//          and settles once the pointer leaves or the user types elsewhere.

import { ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import type { SidebarThreadSortOrder } from "../appSettings";
import type { SidebarThreadSortInput } from "../components/Sidebar.logic";
import { useHeldSidebarThreadSortKeys, useIsPointerWithin } from "./useSidebarThreadOrderHold";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function mount(tagName: "div" | "textarea"): HTMLElement {
  const element = document.createElement(tagName);
  element.style.cssText = "display:block;width:100px;height:100px";
  document.body.append(element);
  cleanups.push(() => element.remove());
  return element;
}

function movePointer(target: Element, pointerType = "mouse") {
  target.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType }));
}

describe("useIsPointerWithin", () => {
  it("tracks mouse movement in and out, and releases when typing elsewhere", async () => {
    const list = mount("div");
    const row = list.appendChild(document.createElement("button"));
    const outside = mount("div");
    const composer = mount("textarea");
    const hook = await renderHook(() => useIsPointerWithin(list));
    try {
      expect(hook.result.current).toBe(false);

      movePointer(row);
      await expect.poll(() => hook.result.current).toBe(true);

      // Modifier keys for Cmd/Shift-click keep the hold.
      document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Meta" }));
      await Promise.resolve();
      expect(hook.result.current).toBe(true);

      composer.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
      await expect.poll(() => hook.result.current).toBe(false);

      movePointer(row);
      await expect.poll(() => hook.result.current).toBe(true);

      movePointer(outside);
      await expect.poll(() => hook.result.current).toBe(false);

      movePointer(row, "touch");
      await Promise.resolve();
      expect(hook.result.current).toBe(false);
    } finally {
      await hook.unmount();
    }
  });
});

describe("useHeldSidebarThreadSortKeys", () => {
  const threadId = ThreadId.makeUnsafe("thread-unread");
  type TestThread = { id: ThreadId } & SidebarThreadSortInput;
  const unread: TestThread = {
    id: threadId,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    latestTurn: {
      turnId: "turn-1" as never,
      state: "completed",
      requestedAt: "2026-03-09T10:00:00.000Z",
      startedAt: "2026-03-09T10:00:00.000Z",
      completedAt: "2026-03-09T10:05:00.000Z",
      assistantMessageId: null,
    },
  };
  const opened: TestThread = { ...unread, lastVisitedAt: "2026-03-09T12:00:00.000Z" };

  it("keeps captured keys while held and follows live keys otherwise", async () => {
    const hook = await renderHook(
      (props?: {
        threads: readonly TestThread[];
        hold: boolean;
        sortOrder: SidebarThreadSortOrder;
      }) =>
        useHeldSidebarThreadSortKeys({
          threads: props?.threads ?? [],
          sortOrder: props?.sortOrder ?? "updated_at",
          attentionFirst: true,
          hold: props?.hold ?? false,
        }),
      { initialProps: { threads: [unread], hold: false, sortOrder: "updated_at" } },
    );
    try {
      expect(hook.result.current.get(threadId)?.attentionRank).toBe(1);

      await hook.rerender({ threads: [unread], hold: true, sortOrder: "updated_at" });
      await hook.rerender({ threads: [opened], hold: true, sortOrder: "updated_at" });
      expect(hook.result.current.get(threadId)?.attentionRank).toBe(1);

      // A sort setting change applies immediately, even mid-hold.
      await hook.rerender({ threads: [opened], hold: true, sortOrder: "created_at" });
      expect(hook.result.current.get(threadId)?.attentionRank).toBe(0);

      await hook.rerender({ threads: [unread], hold: true, sortOrder: "updated_at" });
      await hook.rerender({ threads: [opened], hold: false, sortOrder: "updated_at" });
      expect(hook.result.current.get(threadId)?.attentionRank).toBe(0);
    } finally {
      await hook.unmount();
    }
  });
});

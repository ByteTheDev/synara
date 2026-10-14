import { describe, expect, it } from "vitest";
import { DESKTOP_IDE_MAX_CONTEXT, isDesktopIdeContext, isDesktopIdeScope } from "./desktopIde";

describe("native IDE bridge payloads", () => {
  const context = { threadId: "thread-a", generation: 3, kind: "selection", title: "file.ts", text: "const value = 1;" };
  it("accepts bounded context addressed to a concrete session generation", () => {
    expect(isDesktopIdeContext(context)).toBe(true);
    expect(isDesktopIdeScope({ threadId: null, projectId: null, roots: [] })).toBe(true);
    expect(isDesktopIdeScope({ threadId: "thread-a", projectId: "project-a", roots: ["/worktree"] })).toBe(true);
  });
  it("rejects malformed, unbounded and coerced context", () => {
    for (const value of [null, {}, { ...context, threadId: "" }, { ...context, generation: -1 },
      { ...context, generation: 1.5 }, { ...context, kind: ["selection"] }, { ...context, kind: "execute" },
      { ...context, text: "" }, { ...context, text: "x".repeat(DESKTOP_IDE_MAX_CONTEXT + 1) }]) {
      expect(isDesktopIdeContext(value)).toBe(false);
    }
  });
  it("rejects invalid root lists and embedded nulls", () => {
    for (const roots of [null, [1], [""], ["/tmp/\0file"], Array.from({ length: 17 }, () => "/tmp")]) {
      expect(isDesktopIdeScope({ threadId: "t", projectId: "p", roots })).toBe(false);
    }
  });
});

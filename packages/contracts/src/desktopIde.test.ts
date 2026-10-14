import { describe, expect, it } from "vitest";
import {
  DESKTOP_IDE_MAX_CONTEXT,
  DESKTOP_IDE_APPEARANCE_COLORS,
  isDesktopIdeAppearance,
  isDesktopIdeContext,
  isDesktopIdeScope,
} from "./desktopIde";

describe("native IDE bridge payloads", () => {
  const context = {
    threadId: "thread-a",
    generation: 3,
    kind: "selection",
    title: "file.ts",
    text: "const value = 1;",
  };
  it("accepts bounded context addressed to a concrete session generation", () => {
    expect(isDesktopIdeContext(context)).toBe(true);
    expect(isDesktopIdeScope({ threadId: null, projectId: null, roots: [] })).toBe(true);
    expect(
      isDesktopIdeScope({ threadId: "thread-a", projectId: "project-a", roots: ["/worktree"] }),
    ).toBe(true);
  });
  it("rejects malformed, unbounded and coerced context", () => {
    for (const value of [
      null,
      {},
      { ...context, threadId: "" },
      { ...context, generation: -1 },
      { ...context, generation: 1.5 },
      { ...context, kind: ["selection"] },
      { ...context, kind: "execute" },
      { ...context, text: "" },
      { ...context, text: "x".repeat(DESKTOP_IDE_MAX_CONTEXT + 1) },
    ]) {
      expect(isDesktopIdeContext(value)).toBe(false);
    }
  });
  it("rejects invalid root lists and embedded nulls", () => {
    for (const roots of [
      null,
      [1],
      [""],
      ["/tmp/\0file"],
      Array.from({ length: 17 }, () => "/tmp"),
    ]) {
      expect(isDesktopIdeScope({ threadId: "t", projectId: "p", roots })).toBe(false);
    }
  });
});

describe("Synara appearance bridge", () => {
  const appearance = {
    variant: "dark",
    colors: Object.fromEntries(DESKTOP_IDE_APPEARANCE_COLORS.map((key) => [key, "#181818ff"])),
    uiFontFamily: '-apple-system, "Segoe UI", system-ui, sans-serif',
    uiFontSize: 13,
    radius: 10,
  };
  it("accepts bounded resolved light/dark tokens, alpha colors and adjustable typography", () => {
    expect(isDesktopIdeAppearance(appearance)).toBe(true);
    expect(
      isDesktopIdeAppearance({ ...appearance, variant: "light", uiFontSize: 18, radius: 0 }),
    ).toBe(true);
  });
  it("rejects arbitrary CSS, settings, missing colors and non-finite dimensions", () => {
    for (const value of [
      null,
      {},
      { ...appearance, variant: "system" },
      { ...appearance, colors: { ...appearance.colors, surface: "var(--secret)" } },
      { ...appearance, colors: { ...appearance.colors, surface: "url(https://example.invalid)" } },
      { ...appearance, colors: { ...appearance.colors, "workbench.colorTheme": "custom" } },
      { ...appearance, colors: { surface: "#181818" } },
      { ...appearance, uiFontFamily: "system-ui; background: red" },
      { ...appearance, uiFontFamily: "url(https://example.invalid)" },
      { ...appearance, uiFontFamily: "x".repeat(513) },
      { ...appearance, uiFontSize: Number.NaN },
      { ...appearance, uiFontSize: Number.POSITIVE_INFINITY },
      { ...appearance, uiFontSize: 100 },
      { ...appearance, radius: -1 },
    ])
      expect(isDesktopIdeAppearance(value)).toBe(false);
  });
});

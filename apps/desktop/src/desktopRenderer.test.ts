import { describe, expect, it } from "vitest";
import type { BrowserWindow, WebContents } from "electron";
import {
  desktopRenderer,
  optionalDesktopRenderer,
  registerDesktopRenderer,
} from "./desktopRenderer";

describe("desktop renderer ownership", () => {
  it("retains legacy rendering and maps only the hosted Agent view", () => {
    const native = { id: 1 } as WebContents;
    const agent = { id: 2 } as WebContents;
    const window = { webContents: native, isDestroyed: () => false } as BrowserWindow;
    expect(desktopRenderer(window)).toBe(native);
    registerDesktopRenderer(window, agent);
    expect(desktopRenderer(window)).toBe(agent);
    expect(optionalDesktopRenderer(window)).toBe(agent);
    expect(window.webContents).toBe(native);
  });
  it("does not route a missing or destroyed window", () => {
    expect(optionalDesktopRenderer(null)).toBeUndefined();
    expect(optionalDesktopRenderer(undefined)).toBeUndefined();
    expect(optionalDesktopRenderer({ isDestroyed: () => true } as BrowserWindow)).toBeUndefined();
  });
});

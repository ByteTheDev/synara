import type { BrowserWindow, WebContents } from "electron";

// A Code-OSS BrowserWindow owns the workbench WebContents. Synara's retained
// renderer is a sibling native view; never replace BrowserWindow.webContents or
// give the workbench Synara's authenticated preload.
const renderers = new WeakMap<BrowserWindow, WebContents>();
export function registerDesktopRenderer(window: BrowserWindow, renderer: WebContents): void {
  renderers.set(window, renderer);
}
export function desktopRenderer(window: BrowserWindow): WebContents {
  return renderers.get(window) ?? window.webContents;
}
export function optionalDesktopRenderer(
  window: BrowserWindow | null | undefined,
): WebContents | undefined {
  return window && !window.isDestroyed() ? desktopRenderer(window) : undefined;
}

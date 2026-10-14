import {
  BrowserWindow,
  WebContentsView,
  type BrowserWindowConstructorOptions,
  type WebContents,
} from "electron";

export interface EmbeddedCodeOssWindow {
  readonly window: BrowserWindow;
  readonly shell: WebContents;
  readonly editor: WebContentsView;
}

/**
 * Keep a real BrowserWindow (native menus, dialogs, IPC ownership and lifecycle),
 * but construct the workbench in a child view from the beginning. A window's
 * existing WebContents cannot be moved into a WebContentsView after creation.
 *
 * Only this instance's JS workbench-facing accessor is specialized. No Electron
 * prototype, process-wide constructor, renderer preload or security policy is
 * replaced. Synara retains the original shell through registerDesktopRenderer.
 * The runtime/Electron version gate must remain in CodeOssHost.
 */
export function createEmbeddedCodeOssWindow(
  options: BrowserWindowConstructorOptions,
  shellPreload: string,
): EmbeddedCodeOssWindow {
  const window = new BrowserWindow({
    ...options,
    show: false,
    webPreferences: {
      preload: shellPreload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: true,
      backgroundThrottling: false,
    },
  });
  const shell = window.webContents;
  try {
    const editor = new WebContentsView({
      webPreferences: { ...options.webPreferences, backgroundThrottling: false },
    });
    window.contentView.addChildView(editor);
    // Never flash a second workbench before the existing editor reports bounds.
    editor.setBounds({ x: 0, y: 0, width: 1, height: 1 });
    editor.setVisible(false);
    Object.defineProperty(window, "webContents", {
      enumerable: true,
      configurable: false,
      get: () => editor.webContents,
    });
    window.once("closed", () => {
      // BrowserWindow destroys its original shell, not this independently owned
      // view. Native shutdown vetoes have already run before the window closes.
      if (!editor.webContents.isDestroyed()) editor.webContents.close();
    });
    editor.webContents.on("unresponsive", () => window.emit("unresponsive"));
    editor.webContents.on("responsive", () => window.emit("responsive"));
    return { window, shell, editor };
  } catch (error) {
    window.destroy();
    throw error;
  }
}

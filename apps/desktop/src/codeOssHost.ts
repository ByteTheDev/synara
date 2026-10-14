import {
  app,
  ipcMain,
  Menu,
  MenuItem,
  WebContentsView,
  type BrowserWindow,
  type IpcMainInvokeEvent,
  type Rectangle,
  type WebContents,
  type Session,
} from "electron";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DESKTOP_IDE_PROTOCOL,
  isDesktopIdeContext,
  isDesktopIdeAppearance,
  isDesktopIdeScope,
  type DesktopIdeMode,
  type DesktopIdeScope,
  type DesktopIdeState,
} from "@synara/contracts";
import { registerDesktopRenderer } from "./desktopRenderer";
import { matchesDesktopAccelerator } from "./menuShortcuts";

import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";
const IDE_IPC = DESKTOP_IPC_CHANNELS.ide;
const NATIVE_IPC = "vscode:synara";
const emptyScope: DesktopIdeScope = { threadId: null, projectId: null, roots: [] };
interface RuntimeManifest {
  flavor: string;
  protocol: number;
  commit: string;
  version: string;
  electron: string;
  platform: string;
  arch: string;
}
interface NativeLifecycle {
  check(): Promise<boolean>;
  unload(): Promise<void>;
  reload(): void;
}
type PermissionCheck = NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
type PermissionRequest = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
interface NativeHooks {
  ownsNativeContents(contents: WebContents | null): boolean;
  isAgentContents(contents: WebContents | null): boolean;
  checkAgentPermission: PermissionCheck;
  requestAgentPermission: PermissionRequest;
  args: Record<string, unknown>;
  onWindow(window: BrowserWindow): void;
  onLifecycle(window: BrowserWindow, lifecycle: NativeLifecycle): void;
  isPrepared(windowId: number): boolean;
  isPrimary(windowId: number): boolean;
  canQuit(): boolean;
  focus(window: BrowserWindow): boolean;
  setMenu(menu: Menu | null): void;
}

/** Owns views, not agents, provider processes, or a second application. */
export class CodeOssHost {
  private window: BrowserWindow | null = null;
  private agent: WebContentsView | null = null;
  private pane: Rectangle | null = null;
  private agentMenu: Menu | null = null;
  private workbenchMenu: Menu | null = null;
  private readonly lifecycles = new Map<
    number,
    { window: BrowserWindow; lifecycle: NativeLifecycle }
  >();
  private readonly prepared = new Set<number>();
  private readonly nativeContents = new Set<number>();
  private permissionCheck: PermissionCheck = () => false;
  private permissionRequest: PermissionRequest = (_contents, _permission, callback) =>
    callback(false);
  private pendingShutdown: Promise<boolean> | null = null;
  private agentReady = false;
  private overlayOpen = false;
  private focusPending = false;
  private ideFocusAgent = false;
  private accelerator: string | null = "CommandOrControl+Alt+G";
  private readonly runtime: string | null;
  private readonly manifest: RuntimeManifest | null;
  private state: DesktopIdeState;

  constructor(
    private readonly options: {
      runtimePath: string;
      profilePath: string;
      preloadPath: string;
      flavor: string;
      canQuit: () => boolean;
      isQuitRequestActive: (requestId: string) => boolean;
      onMode?: (mode: DesktopIdeMode) => void;
    },
  ) {
    const manifestPath = Path.join(options.runtimePath, "synara-runtime.json");
    this.runtime = existsSync(manifestPath) ? options.runtimePath : null;
    this.manifest = this.runtime
      ? (JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest)
      : null;
    if (
      this.manifest &&
      (this.manifest.flavor !== options.flavor ||
        this.manifest.protocol !== DESKTOP_IDE_PROTOCOL ||
        !/^[a-f0-9]{40}$/.test(this.manifest.commit) ||
        this.manifest.electron !== process.versions.electron ||
        this.manifest.platform !== process.platform ||
        this.manifest.arch !== process.arch)
    ) {
      throw new Error("The bundled Code-OSS runtime does not match this Synara desktop build.");
    }
    this.state = {
      protocol: DESKTOP_IDE_PROTOCOL,
      status: this.runtime ? "starting" : "unavailable",
      mode: "agent",
      scope: emptyScope,
      generation: 0,
      attention: 0,
      message: this.runtime ? null : "This build does not include the native Code-OSS runtime.",
    };
  }

  get enabled(): boolean {
    return this.runtime !== null;
  }
  getWindow(): BrowserWindow | null {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }
  getState(): DesktopIdeState {
    return this.state;
  }
  setAgentMenu(menu: Menu | null): void {
    // The native keybinding service is authoritative, including user changes.
    // The retained Agent renderer also handles it when docked inside IDE Mode.
    if (menu && this.runtime && !menu.getMenuItemById("synara-mode-menu")) {
      menu.append(
        new MenuItem({
          id: "synara-mode-menu",
          label: "Agent / IDE",
          submenu: [
            {
              id: "synara-mode-switch",
              label: "Switch Agent / IDE Mode",
              // The retained renderer handles the configurable shortcut in both modes.
              click: () => {
                if (this.state.status === "ready")
                  this.setMode(this.state.mode === "agent" ? "ide" : "agent");
              },
            },
          ],
        }),
      );
    }
    this.agentMenu = menu;
    if (this.state.mode === "agent") Menu.setApplicationMenu(menu);
  }

  setAgentPermissions(check: PermissionCheck, request: PermissionRequest): void {
    this.permissionCheck = check;
    this.permissionRequest = request;
  }

  async start(): Promise<void> {
    this.registerIpc();
    if (!this.runtime) return;
    // Code-OSS's editor state lives inside the existing Electron profile. No
    // separate Synara database, auth store, updater, or profile is introduced.
    await mkdir(this.options.profilePath, { recursive: true });
    // The embedded startup skips upstream command-line initialization. Create
    // its absent argv file without changing any existing Synara configuration.
    const product = JSON.parse(readFileSync(Path.join(this.runtime, "product.json"), "utf8")) as {
      dataFolderName: string;
    };
    if (
      typeof product.dataFolderName !== "string" ||
      Path.basename(product.dataFolderName) !== product.dataFolderName
    )
      throw new Error("Invalid native product data folder.");
    const argvPath = Path.join(app.getPath("home"), product.dataFolderName, "argv.json");
    await mkdir(Path.dirname(argvPath), { recursive: true });
    try {
      await writeFile(argvPath, JSON.stringify({ "enable-crash-reporter": false }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const workspace = Path.join(this.options.profilePath, "synara.code-workspace");
    try {
      await writeFile(
        workspace,
        JSON.stringify(
          {
            folders: [],
            settings: { "chat.disableAIFeatures": true, "workbench.startupEditor": "none" },
          },
          null,
          2,
        ),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const hooks: NativeHooks = {
      ownsNativeContents: (contents) => Boolean(contents && this.nativeContents.has(contents.id)),
      isAgentContents: (contents) => Boolean(contents && contents === this.agent?.webContents),
      checkAgentPermission: (...args) => this.permissionCheck(...args),
      requestAgentPermission: (...args) => this.permissionRequest(...args),
      args: {
        _: [workspace],
        "user-data-dir": this.options.profilePath,
        "shared-data-dir": Path.join(this.options.profilePath, "SharedData"),
        "extensions-dir": Path.join(this.options.profilePath, "extensions"),
        "builtin-extensions-dir": Path.join(this.runtime, "extensions"),
        "disable-updates": true,
        "disable-telemetry": true,
        "skip-welcome": true,
        "skip-release-notes": true,
      },
      onWindow: (window) => this.attachWindow(window),
      onLifecycle: (window, lifecycle) => {
        this.lifecycles.set(window.id, { window, lifecycle });
        window.once("closed", () => {
          this.lifecycles.delete(window.id);
          this.prepared.delete(window.id);
        });
      },
      isPrepared: (id) => this.prepared.has(id),
      isPrimary: (id) => this.window?.id === id,
      canQuit: this.options.canQuit,
      focus: (window) => {
        if (window !== this.window || this.state.mode !== "agent" || !this.agent) return false;
        this.agent.webContents.focus();
        return true;
      },
      setMenu: (menu) => {
        this.workbenchMenu = menu;
        if (this.state.mode === "ide") Menu.setApplicationMenu(menu);
      },
    };
    (
      globalThis as typeof globalThis & { __SYNARA_EMBEDDED_CODE_OSS__?: NativeHooks }
    ).__SYNARA_EMBEDDED_CODE_OSS__ = hooks;
    // Synara development uses Vite, not Code-OSS development/debug listeners.
    delete process.env.VSCODE_DEV;
    delete process.env.VSCODE_DEV_SERVER_URL;
    const entry = pathToFileURL(Path.join(this.runtime, "out/synara.js")).href;
    try {
      const runtime = (await import(entry)) as { start: (locale: string) => Promise<void> };
      await runtime.start(app.getLocale());
      if (!this.getWindow())
        throw new Error("Code-OSS did not create its native workbench window.");
    } catch (error) {
      this.state = {
        ...this.state,
        status: "error",
        message: "Code-OSS startup failed. See the desktop log.",
      };
      this.publish();
      // Never start a second, independent Electron shell after partial startup.
      throw error;
    }
  }

  /** Called only AFTER Synara's running-chat consent, before stopping its backend.
   * Collect every native veto before unloading any window. A cancellation leaves
   * agents, editors and extension hosts running. The normal native close handler
   * then skips already-prepared windows, avoiding a second veto after backend exit.
   */
  async permitShutdown(): Promise<boolean> {
    if (!this.runtime || !this.window) return true;
    if (this.pendingShutdown) return this.pendingShutdown;
    if (this.state.status !== "ready" || this.lifecycles.size === 0) return false;
    const pending = this.prepareShutdown();
    this.pendingShutdown = pending;
    try {
      return await pending;
    } finally {
      this.pendingShutdown = null;
    }
  }
  private async prepareShutdown(): Promise<boolean> {
    const windows = [...this.lifecycles.values()].filter(
      ({ window }) => !window.isDestroyed() && !this.prepared.has(window.id),
    );
    for (const { lifecycle } of windows) {
      if (await lifecycle.check()) return false;
    }
    for (const { window } of windows) if (!window.isDestroyed()) window.setEnabled(false);
    try {
      for (const { window, lifecycle } of windows) {
        if (!window.isDestroyed()) {
          this.prepared.add(window.id);
          await lifecycle.unload();
        }
      }
      return true;
    } catch (error) {
      this.restoreAfterFailedShutdown();
      throw error;
    }
  }
  restoreAfterFailedShutdown(): void {
    for (const { window, lifecycle } of this.lifecycles.values()) {
      if (window.isDestroyed()) continue;
      window.setEnabled(true);
      if (this.prepared.delete(window.id)) lifecycle.reload();
    }
  }

  private attachWindow(window: BrowserWindow): void {
    this.nativeContents.add(window.webContents.id);
    const contentsId = window.webContents.id;
    window.once("closed", () => this.nativeContents.delete(contentsId));
    // Native editor auxiliary windows remain Code-OSS owned, not another agent runtime.
    if (this.getWindow()) return;
    this.window = window;
    this.agent = new WebContentsView({
      webPreferences: {
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webviewTag: true,
        backgroundThrottling: false,
      },
    });
    registerDesktopRenderer(window, this.agent.webContents);
    window.contentView.addChildView(this.agent);
    this.agent.webContents.on("before-input-event", (event, input) => {
      if (
        this.state.status !== "ready" ||
        !matchesDesktopAccelerator(this.accelerator, process.platform, input)
      )
        return;
      // Suppress DOM and menu dispatch together so the same chord cannot toggle twice.
      event.preventDefault();
      this.setMode(this.state.mode === "agent" ? "ide" : "agent");
    });
    this.agent.webContents.on("did-finish-load", () => {
      this.agentReady = true;
      this.publish();
    });
    window.on("resize", () => this.layout());
    window.webContents.on("zoom-changed", () => this.layout());
    window.once("closed", () => {
      this.agentReady = false;
      this.agent?.webContents.close();
      this.agent = null;
      this.window = null;
    });
    this.layout();
  }

  private trustedAgent(event: IpcMainInvokeEvent): boolean {
    return Boolean(
      this.agent &&
      event.sender === this.agent.webContents &&
      event.senderFrame === event.sender.mainFrame,
    );
  }
  private trustedWorkbench(event: IpcMainInvokeEvent): boolean {
    return Boolean(
      this.window &&
      !this.window.isDestroyed() &&
      event.sender === this.window.webContents &&
      event.senderFrame === event.sender.mainFrame,
    );
  }
  private registerIpc(): void {
    const handleAgent = (channel: string, handler: (value: unknown) => unknown) => {
      ipcMain.handle(channel, (event, value: unknown) => {
        // The legacy renderer may query availability but gets no native capabilities.
        if (channel === IDE_IPC.state && !this.runtime) return this.state;
        if (!this.trustedAgent(event)) throw new Error("Untrusted Synara IDE sender.");
        return handler(value);
      });
    };
    handleAgent(IDE_IPC.state, () => this.state);
    handleAgent(IDE_IPC.mode, (value) => this.setMode(value));
    handleAgent(IDE_IPC.scope, (value) => {
      if (!isDesktopIdeScope(value) || !value.roots.every((root) => Path.isAbsolute(root)))
        throw new Error("Invalid IDE workspace context.");
      const scope = {
        threadId: value.threadId,
        projectId: value.projectId,
        roots: [...new Set(value.roots)],
      };
      if (JSON.stringify(scope) === JSON.stringify(this.state.scope)) return;
      this.state = { ...this.state, scope, generation: this.state.generation + 1 };
      this.publish();
    });
    handleAgent(IDE_IPC.prepareQuit, (value) => {
      if (typeof value !== "string" || !this.options.isQuitRequestActive(value))
        throw new Error("No matching Synara quit request.");
      return this.permitShutdown();
    });
    handleAgent(IDE_IPC.appearance, (value) => {
      if (!isDesktopIdeAppearance(value)) throw new Error("Invalid Synara appearance tokens.");
      if (JSON.stringify(value) === JSON.stringify(this.state.appearance)) return;
      this.state = { ...this.state, appearance: value };
      this.publish();
    });
    handleAgent(IDE_IPC.attention, (value) => {
      if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 100000)
        throw new Error("Invalid attention count.");
      if (this.state.attention === value) return;
      this.state = { ...this.state, attention: Number(value) };
      this.publish();
    });
    ipcMain.handle(NATIVE_IPC, (event, request: unknown) => {
      if (!this.trustedWorkbench(event) || !request || typeof request !== "object")
        throw new Error("Untrusted native workbench sender.");
      const { kind, value } = request as { kind?: unknown; value?: unknown };
      switch (kind) {
        case "ready":
          this.state = { ...this.state, status: "ready", message: null };
          this.publish();
          return this.state;
        case "state":
          return this.state;
        case "mode":
          return this.setMode(value);
        case "pane": {
          const rect = value as (Rectangle & { visible?: unknown }) | null;
          if (
            !rect ||
            ![rect.x, rect.y, rect.width, rect.height].every(
              (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n < 100000,
            )
          )
            throw new Error("Invalid native pane bounds.");
          this.pane =
            rect.visible === true
              ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
              : null;
          this.layout();
          return;
        }
        case "shortcut": {
          if (
            value !== null &&
            (typeof value !== "string" || value.length > 160 || /[\r\n\0]/u.test(value))
          )
            throw new Error("Invalid mode shortcut.");
          this.accelerator = value as string | null;
          // Electron menu items are immutable here. before-input-event reads
          // the updated accelerator without rebuilding or double-registering it.
          return;
        }
        case "overlay":
          if (typeof value !== "boolean") throw new Error("Invalid native overlay state.");
          this.overlayOpen = value;
          this.layout();
          if (value && this.state.mode === "ide") this.window?.webContents.focus();
          return;
        case "focus-agent":
          this.focusPending = true;
          this.layout();
          return;
        case "attention":
          this.agent?.webContents.send(DESKTOP_IPC_CHANNELS.menuAction, "ide-next-attention");
          this.focusPending = true;
          this.layout();
          return;
        case "context":
          if (
            !isDesktopIdeContext(value) ||
            value.threadId !== this.state.scope.threadId ||
            value.generation !== this.state.generation ||
            !this.agentReady
          )
            throw new Error(
              "The selected Synara session changed. Select the session and send the context again.",
            );
          this.agent?.webContents.send(IDE_IPC.context, value);
          this.focusPending = true;
          this.layout();
          return;
        default:
          throw new Error("Unknown native workbench operation.");
      }
    });
  }

  private setMode(value: unknown): DesktopIdeState {
    if (value !== "agent" && value !== "ide") throw new Error("Invalid desktop mode.");
    if (this.state.status !== "ready")
      throw new Error(this.state.message ?? "The native workbench is still starting.");
    if (value === this.state.mode) return this.state;
    if (this.state.mode === "ide")
      this.ideFocusAgent = this.agent?.webContents.isFocused() ?? false;
    this.focusPending = false;
    this.state = { ...this.state, mode: value };
    this.options.onMode?.(value);
    Menu.setApplicationMenu(value === "agent" ? this.agentMenu : this.workbenchMenu);
    this.layout();
    this.publish();
    if (value === "agent" || (this.ideFocusAgent && this.agent?.getVisible()))
      this.agent?.webContents.focus();
    else this.window?.webContents.focus();
    return this.state;
  }
  private layout(): void {
    if (!this.agent || !this.window || this.window.isDestroyed()) return;
    if (this.overlayOpen && this.state.mode === "ide") {
      this.agent.setVisible(false);
      return;
    }
    const { width, height } = this.window.getContentBounds();
    if (this.state.mode === "agent") {
      this.agent.setBounds({ x: 0, y: 0, width, height });
      this.agent.setVisible(true);
      return;
    }
    if (!this.pane || this.pane.width === 0 || this.pane.height === 0) {
      this.agent.setVisible(false);
      return;
    }
    // Native pane rectangles use CSS pixels; Electron bounds use device-independent pixels.
    const zoom = this.window.webContents.getZoomFactor();
    const x = Math.min(width, Math.round(this.pane.x * zoom));
    const y = Math.min(height, Math.round(this.pane.y * zoom));
    this.agent.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.round(this.pane.width * zoom))),
      height: Math.max(0, Math.min(height - y, Math.round(this.pane.height * zoom))),
    });
    this.agent.setVisible(true);
    if (this.focusPending) {
      this.focusPending = false;
      this.agent.webContents.focus();
    }
  }
  /** A quit dialog must remain reachable even when the native agent pane is hidden. */
  showQuitDialog(): void {
    if (this.state.status === "ready") this.setMode("agent");
  }
  private publish(): void {
    if (this.agentReady && this.agent && !this.agent.webContents.isDestroyed())
      this.agent.webContents.send(IDE_IPC.state, this.state);
    if (this.window && !this.window.isDestroyed())
      this.window.webContents.send(NATIVE_IPC, this.state);
  }
}

import { app, ipcMain, Menu, type BrowserWindow, type BrowserWindowConstructorOptions, type IpcMainInvokeEvent, type Session, type WebContents, type WebContentsView } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import * as Path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DESKTOP_IDE_PROTOCOL, isDesktopIdeAppearance, isDesktopIdeContext, isDesktopIdeRequest,
  isDesktopIdeScope, isDesktopIdeSurface,
  type DesktopIdeDocument, type DesktopIdeEvent, type DesktopIdeReply, type DesktopIdeRequest,
  type DesktopIdeScope, type DesktopIdeState, type DesktopIdeSurface,
} from "@synara/contracts";
import { createEmbeddedCodeOssWindow } from "./codeOssWindow";
import { registerDesktopRenderer } from "./desktopRenderer";
import { DESKTOP_IPC_CHANNELS } from "./ipcChannels";

const IPC = DESKTOP_IPC_CHANNELS.ide;
const NATIVE = "vscode:synara";
interface RuntimeManifest {
  flavor: string; protocol: number; commit: string; version: string;
  electron: string; platform: string; arch: string;
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
  createWindow(options: BrowserWindowConstructorOptions): BrowserWindow;
  onWindow(window: BrowserWindow): void;
  onLifecycle(window: BrowserWindow, lifecycle: NativeLifecycle): void;
  isPrepared(windowId: number): boolean;
  isPrimary(windowId: number): boolean;
  canQuit(): boolean;
  focus(window: BrowserWindow): boolean;
  setMenu(menu: Menu | null): void;
}
interface PendingRequest {
  readonly resolve: (reply: DesktopIdeReply) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Native IDE services belong to the existing application; surfaces are only leases. */
export class CodeOssHost {
  private window: BrowserWindow | null = null;
  private agent: WebContents | null = null;
  private editor: WebContentsView | null = null;
  private surface: DesktopIdeSurface | null = null;
  private quitDialogOpen = false;
  private agentReady = false;
  private permissionCheck: PermissionCheck = () => false;
  private permissionRequest: PermissionRequest = (_contents, _permission, callback) => callback(false);
  private readonly lifecycles = new Map<number, { window: BrowserWindow; lifecycle: NativeLifecycle }>();
  private readonly prepared = new Set<number>();
  private readonly nativeContents = new Set<number>();
  private readonly roots = new Map<string, string>();
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequest = 0;
  private pendingShutdown: Promise<boolean> | null = null;
  private readonly runtime: string | null;
  private state: DesktopIdeState;

  constructor(private readonly options: {
    runtimePath: string;
    profilePath: string;
    preloadPath: string;
    flavor: string;
    canQuit: () => boolean;
    isQuitRequestActive: (requestId: string) => boolean;
  }) {
    const manifestPath = Path.join(options.runtimePath, "synara-runtime.json");
    this.runtime = existsSync(manifestPath) ? options.runtimePath : null;
    if (this.runtime) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest;
      if (manifest.flavor !== options.flavor || manifest.protocol !== DESKTOP_IDE_PROTOCOL ||
          !/^[a-f0-9]{40}$/u.test(manifest.commit) || manifest.electron !== process.versions.electron ||
          manifest.platform !== process.platform || manifest.arch !== process.arch) {
        throw new Error("The bundled Code-OSS runtime does not match this Synara desktop build.");
      }
    }
    this.state = {
      protocol: DESKTOP_IDE_PROTOCOL,
      status: this.runtime ? "starting" : "unavailable",
      scope: { threadId: null, projectId: null, roots: [] },
      generation: 0,
      message: this.runtime ? null : "This build does not include the native Code-OSS runtime.",
    };
  }

  get enabled(): boolean { return this.runtime !== null; }
  getWindow(): BrowserWindow | null { return this.window && !this.window.isDestroyed() ? this.window : null; }
  getState(): DesktopIdeState { return this.state; }
  setAgentMenu(menu: Menu | null): void { Menu.setApplicationMenu(menu); }
  setAgentPermissions(check: PermissionCheck, request: PermissionRequest): void {
    this.permissionCheck = check;
    this.permissionRequest = request;
  }

  async start(): Promise<void> {
    this.registerIpc();
    if (!this.runtime) return;
    await mkdir(this.options.profilePath, { recursive: true });
    const product = JSON.parse(readFileSync(Path.join(this.runtime, "product.json"), "utf8")) as { dataFolderName: string };
    if (typeof product.dataFolderName !== "string" || Path.basename(product.dataFolderName) !== product.dataFolderName) {
      throw new Error("Invalid native product data folder.");
    }
    const argvPath = Path.join(app.getPath("home"), product.dataFolderName, "argv.json");
    await mkdir(Path.dirname(argvPath), { recursive: true });
    await this.createIfAbsent(argvPath, { "enable-crash-reporter": false });
    const workspace = Path.join(this.options.profilePath, "synara.code-workspace");
    await this.createIfAbsent(workspace, {
      folders: [],
      settings: {
        "chat.disableAIFeatures": true,
        "workbench.startupEditor": "none",
        "window.restoreWindows": "one",
        "workbench.editor.dragToOpenWindow": false,
      },
    });
    const hooks: NativeHooks = {
      ownsNativeContents: (contents) => Boolean(contents && this.nativeContents.has(contents.id)),
      isAgentContents: (contents) => Boolean(contents && contents === this.agent),
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
      createWindow: (options) => this.createWindow(options),
      onWindow: (window) => {
        if (window !== this.window) throw new Error("Separate IDE windows are not supported in Synara.");
      },
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
        if (window !== this.window || !this.agent || this.editor?.getVisible()) return false;
        this.agent.focus();
        return true;
      },
      // The current Synara menu remains authoritative. Code-OSS commands are
      // exposed by the existing editor controls and its command palette.
      setMenu: () => undefined,
    };
    (globalThis as typeof globalThis & { __SYNARA_EMBEDDED_CODE_OSS__?: NativeHooks }).__SYNARA_EMBEDDED_CODE_OSS__ = hooks;
    delete process.env.VSCODE_DEV;
    delete process.env.VSCODE_DEV_SERVER_URL;
    try {
      const entry = pathToFileURL(Path.join(this.runtime, "out/synara.js")).href;
      const runtime = (await import(entry)) as { start(locale: string): Promise<void> };
      await runtime.start(app.getLocale());
      if (!this.getWindow()) throw new Error("Code-OSS did not initialize the application window.");
    } catch (error) {
      this.fail("Code-OSS startup failed. See the desktop log.");
      throw error;
    }
  }

  private async createIfAbsent(path: string, contents: unknown): Promise<void> {
    try { await writeFile(path, JSON.stringify(contents, null, 2), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }

  private createWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
    if (this.getWindow()) throw new Error("Open the folder in Synara's current workspace instead of a separate IDE window.");
    const embedded = createEmbeddedCodeOssWindow(options, this.options.preloadPath);
    this.window = embedded.window;
    this.agent = embedded.shell;
    this.editor = embedded.editor;
    this.nativeContents.add(embedded.editor.webContents.id);
    registerDesktopRenderer(embedded.window, embedded.shell);
    embedded.shell.on("did-finish-load", () => { this.agentReady = true; this.publish(); });
    embedded.shell.on("did-start-loading", () => {
      this.agentReady = false;
      this.surface = null;
      this.layout();
    });
    embedded.shell.on("zoom-changed", () => this.layout());
    embedded.window.on("resize", () => this.layout());
    embedded.editor.webContents.on("render-process-gone", () => {
      this.fail("The native editor stopped. Unsaved work remains in Code-OSS recovery storage; restart Synara to recover it.");
    });
    embedded.window.once("closed", () => {
      this.rejectPending(new Error("The application window closed."));
      this.nativeContents.delete(embedded.editor.webContents.id);
      this.agentReady = false;
      this.surface = null;
      this.agent = null;
      this.editor = null;
      this.window = null;
    });
    return embedded.window;
  }

  private trusted(event: IpcMainInvokeEvent, contents: WebContents | null): boolean {
    return Boolean(contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame);
  }
  private registerIpc(): void {
    const handle = (channel: string, handler: (value: unknown) => unknown) => {
      ipcMain.handle(channel, (event, value: unknown) => {
        if (channel === IPC.state && !this.runtime) return this.state;
        if (!this.trusted(event, this.agent)) throw new Error("Untrusted embedded editor sender.");
        return handler(value);
      });
    };
    handle(IPC.state, () => this.state);
    handle(IPC.scope, async (value) => {
      if (!isDesktopIdeScope(value) || !value.roots.every((root) => Path.isAbsolute(root))) throw new Error("Invalid workspace context.");
      // Resolve all grants before publishing any of them. Keep earlier grants
      // for open buffers/terminals; switching conversations does not destroy them.
      const grants = await Promise.all(value.roots.map(async (root) => [Path.resolve(root), await realpath(root)] as const));
      for (const [root, actual] of grants) this.roots.set(root, actual);
      const scope: DesktopIdeScope = { threadId: value.threadId, projectId: value.projectId, roots: [...new Set(grants.map(([root]) => root))] };
      if (JSON.stringify(scope) === JSON.stringify(this.state.scope)) return;
      this.state = { ...this.state, scope, generation: this.state.generation + 1 };
      this.publish();
    });
    handle(IPC.appearance, (value) => {
      if (!isDesktopIdeAppearance(value)) throw new Error("Invalid appearance tokens.");
      if (JSON.stringify(value) === JSON.stringify(this.state.appearance)) return;
      this.state = { ...this.state, appearance: value };
      this.publish();
    });
    handle(IPC.surface, (value) => {
      if (!isDesktopIdeSurface(value)) throw new Error("Invalid editor surface.");
      this.surface = value;
      this.quitDialogOpen = false;
      this.layout();
    });
    handle(IPC.releaseSurface, (value) => {
      if (typeof value !== "string" || value.length > 128) throw new Error("Invalid editor lease.");
      if (this.surface?.lease !== value) return;
      this.surface = null;
      this.layout();
    });
    handle(IPC.request, async (value) => {
      if (!isDesktopIdeRequest(value)) throw new Error("Invalid embedded editor operation.");
      await this.authorize(value);
      return this.request(value);
    });
    handle(IPC.prepareQuit, (value) => {
      if (typeof value !== "string" || !this.options.isQuitRequestActive(value)) throw new Error("No matching Synara quit request.");
      return this.permitShutdown();
    });
    ipcMain.handle(NATIVE, (event, packet: unknown) => {
      if (!this.trusted(event, this.editor?.webContents ?? null) || !packet || typeof packet !== "object") {
        throw new Error("Untrusted native workbench sender.");
      }
      const { kind, value } = packet as { kind?: unknown; value?: unknown };
      switch (kind) {
        case "ready":
          if (value !== DESKTOP_IDE_PROTOCOL) throw new Error("Incompatible embedded editor protocol.");
          this.state = { ...this.state, status: "ready", message: null };
          this.publish();
          return this.state;
        case "state": return this.state;
        case "reply": {
          const reply = value as { id?: unknown; result?: DesktopIdeReply; error?: unknown } | null;
          if (!reply || typeof reply.id !== "number") throw new Error("Invalid workbench reply.");
          const pending = this.pending.get(reply.id);
          if (!pending) return;
          this.pending.delete(reply.id);
          clearTimeout(pending.timer);
          if (typeof reply.error === "string") pending.reject(new Error(reply.error.slice(0, 8192)));
          else pending.resolve(reply.result ?? null);
          return;
        }
        case "event": {
          const nativeEvent = value as DesktopIdeEvent | null;
          if (!nativeEvent || typeof nativeEvent !== "object" || typeof nativeEvent.kind !== "string") throw new Error("Invalid workbench event.");
          this.sendEvent(nativeEvent);
          return;
        }
        case "context":
          if (!isDesktopIdeContext(value) || value.threadId !== this.state.scope.threadId || value.generation !== this.state.generation || !this.agentReady) {
            throw new Error("The selected Synara session changed. Select the session and add the context again.");
          }
          this.agent?.send(IPC.context, value);
          this.agent?.focus();
          return;
        case "focus-agent": this.agent?.focus(); return;
        default: throw new Error("Unknown native workbench operation.");
      }
    });
  }

  private async authorize(request: DesktopIdeRequest): Promise<void> {
    if (this.state.status !== "ready") throw new Error(this.state.message ?? "The native editor is starting.");
    if (this.pendingShutdown || this.prepared.size) throw new Error("Synara is preparing to close.");
    if ("document" in request) await this.authorizeDocument(request.document);
    if ("root" in request && !this.roots.has(Path.resolve(request.root))) throw new Error("Select this workspace in Synara before accessing it.");
    if (request.kind === "git.stage" || request.kind === "git.unstage") {
      for (const path of request.paths) this.containedPath({ root: request.root, path });
    }
  }
  private containedPath(document: DesktopIdeDocument): string {
    if (!Path.isAbsolute(document.root) || Path.isAbsolute(document.path)) throw new Error("Expected a workspace-relative file path.");
    const root = Path.resolve(document.root);
    if (!this.roots.has(root)) throw new Error("Select this workspace in Synara before accessing its files.");
    const absolute = Path.resolve(root, document.path);
    const relative = Path.relative(root, absolute);
    if (!relative || relative === ".." || relative.startsWith(`..${Path.sep}`) || Path.isAbsolute(relative)) throw new Error("The file must remain inside its workspace.");
    return absolute;
  }
  private async authorizeDocument(document: DesktopIdeDocument): Promise<void> {
    const absolute = this.containedPath(document);
    const actual = await realpath(absolute);
    const root = this.roots.get(Path.resolve(document.root))!;
    const relative = Path.relative(root, actual);
    if (!relative || relative === ".." || relative.startsWith(`..${Path.sep}`) || Path.isAbsolute(relative)) throw new Error("The file resolves outside its workspace.");
  }
  private request(request: DesktopIdeRequest): Promise<DesktopIdeReply> {
    const contents = this.editor?.webContents;
    if (!contents || contents.isDestroyed()) return Promise.reject(new Error("The native editor is unavailable."));
    if (this.pending.size >= 64) return Promise.reject(new Error("The native editor is busy. Retry after the current operation completes."));
    const id = ++this.nextRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A timed-out write is not retried through a different backend.
        reject(new Error("The native editor did not respond. Its buffers are retained; no fallback write was attempted."));
      }, request.kind.startsWith("extensions.") ? 120_000 : 30_000);
      this.pending.set(id, { resolve, reject, timer });
      try { contents.send(`${NATIVE}:request`, { id, request }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  private sendEvent(event: DesktopIdeEvent): void {
    if (this.agentReady && this.agent && !this.agent.isDestroyed()) this.agent.send(IPC.event, event);
  }
  private fail(message: string): void {
    this.state = { ...this.state, status: "error", message };
    this.rejectPending(new Error(message));
    this.layout();
    this.publish();
  }
  private layout(): void {
    if (!this.editor || !this.window || this.window.isDestroyed()) return;
    const surface = this.surface;
    if (!surface?.visible || surface.blocked || this.quitDialogOpen || this.state.status === "error" || surface.width < 1 || surface.height < 1) {
      this.editor.setVisible(false);
      return;
    }
    const { width, height } = this.window.getContentBounds();
    const zoom = this.agent?.getZoomFactor() ?? 1;
    const x = Math.min(width, Math.round(surface.x * zoom));
    const y = Math.min(height, Math.round(surface.y * zoom));
    this.editor.setBounds({
      x, y,
      width: Math.max(0, Math.min(width - x, Math.round(surface.width * zoom))),
      height: Math.max(0, Math.min(height - y, Math.round(surface.height * zoom))),
    });
    this.editor.setVisible(true);
  }
  showQuitDialog(): void {
    this.quitDialogOpen = true;
    this.layout();
    this.agent?.focus();
  }
  private publish(): void {
    if (this.agentReady && this.agent && !this.agent.isDestroyed()) this.agent.send(IPC.state, this.state);
    if (this.editor && !this.editor.webContents.isDestroyed()) this.editor.webContents.send(NATIVE, this.state);
  }

  /** All native vetoes precede provider/backend teardown. A cancelled close is inert. */
  async permitShutdown(): Promise<boolean> {
    if (!this.runtime || !this.window) return true;
    if (this.pendingShutdown) return this.pendingShutdown;
    if (this.state.status !== "ready" || this.lifecycles.size === 0) return false;
    const pending = this.prepareShutdown();
    this.pendingShutdown = pending;
    try { return await pending; } finally { this.pendingShutdown = null; }
  }
  private async prepareShutdown(): Promise<boolean> {
    const windows = [...this.lifecycles.values()].filter(({ window }) => !window.isDestroyed() && !this.prepared.has(window.id));
    for (const { lifecycle } of windows) if (await lifecycle.check()) return false;
    for (const { window } of windows) if (!window.isDestroyed()) window.setEnabled(false);
    try {
      for (const { window, lifecycle } of windows) {
        if (!window.isDestroyed()) { this.prepared.add(window.id); await lifecycle.unload(); }
      }
      return true;
    } catch (error) { this.restoreAfterFailedShutdown(); throw error; }
  }
  restoreAfterFailedShutdown(): void {
    this.quitDialogOpen = false;
    for (const { window, lifecycle } of this.lifecycles.values()) {
      if (window.isDestroyed()) continue;
      window.setEnabled(true);
      if (this.prepared.delete(window.id)) lifecycle.reload();
    }
    this.layout();
  }
}

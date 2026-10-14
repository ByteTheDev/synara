import { Disposable, DisposableStore } from "../../base/common/lifecycle.js";
import { ITerminalService, type ITerminalInstance } from "../../workbench/contrib/terminal/browser/terminal.js";
import type { DesktopIdeScope } from "../common/desktopIde.js";
import type { DesktopPtyEvent, DesktopPtyExternal, DesktopPtyOwner, DesktopPtyReply, DesktopPtyRequest, DesktopPtySnapshot, DesktopPtySpawn } from "../common/desktopPty.js";

const OWNER = "synara-terminal-manager";
const HISTORY_LIMIT = 1024 * 1024;
interface Entry {
  readonly id: string;
  readonly owner: DesktopPtyOwner;
  readonly cwd: string;
  readonly instance: ITerminalInstance;
  readonly external: boolean;
  readonly lifetime: DisposableStore;
  readonly history: Array<{ sequence: number; data: string }>;
  readonly paused: Set<string>;
  historyLength: number;
  sequence: number;
  cols: number;
  rows: number;
  exited: boolean;
}

/** One native terminal instance/PTY for each existing Synara terminal ID. */
export class SynaraPtys extends Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly instances = new Map<number, Entry>();
  private readonly opening = new Map<string, Promise<Entry>>();
  private readonly waitingExternal = new Set<ITerminalInstance>();
  private scope: DesktopIdeScope = { threadId: null, projectId: null, roots: [] };

  constructor(private readonly terminals: ITerminalService, private readonly emit: (event: DesktopPtyEvent) => void) {
    super();
    this._register(terminals.onDidCreateInstance((instance) => {
      if (instance.shellLaunchConfig.reconnectionProperties?.ownerId === OWNER) return;
      this.waitingExternal.add(instance);
      void this.adoptExternal(instance, false);
    }));
    this._register(terminals.onDidChangeActiveInstance((instance) => {
      if (!instance) return;
      const entry = this.instances.get(instance.instanceId);
      if (entry) this.emit({ kind: "external", terminal: this.external(entry, true) });
      else void this.adoptExternal(instance, true);
    }));
    this._register(terminals.onDidDisposeInstance((instance) => {
      this.waitingExternal.delete(instance);
      const entry = this.instances.get(instance.instanceId);
      if (!entry) return;
      this.exited(entry, instance.exitCode ?? 0);
      entry.lifetime.dispose();
      this.instances.delete(instance.instanceId);
      if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    }));
  }

  setScope(scope: DesktopIdeScope): void {
    this.scope = scope;
    for (const instance of this.waitingExternal) void this.adoptExternal(instance, false);
  }
  private external(entry: Entry, reveal: boolean): DesktopPtyExternal {
    return { id: entry.id, owner: entry.owner, cwd: entry.cwd, title: entry.instance.title.slice(0, 1024), reveal };
  }
  private async adoptExternal(instance: ITerminalInstance, reveal: boolean): Promise<void> {
    if (instance.isDisposed || this.instances.has(instance.instanceId) || instance.shellLaunchConfig.reconnectionProperties?.ownerId === OWNER) return;
    const scope = this.scope;
    if (!scope.threadId || !scope.roots[0]) return;
    // Reserve synchronously so a creation event and a show() event cannot adopt
    // the same extension/debugger terminal into two Synara sessions.
    this.waitingExternal.delete(instance);
    const owner = { threadId: scope.threadId, terminalId: `code-oss-${instance.instanceId}` };
    const id = JSON.stringify([owner.threadId, owner.terminalId]);
    const cwd = instance.initialCwd || instance.cwd || scope.roots[0];
    const entry = this.bind(id, owner, cwd, instance, true, Math.max(20, instance.cols || 80), Math.max(5, instance.rows || 24));
    try {
      await instance.processReady;
      if (!entry.exited && !instance.isDisposed) this.emit({ kind: "external", terminal: this.external(entry, reveal) });
    } catch {
      this.exited(entry, 1);
    }
  }

  private bind(id: string, owner: DesktopPtyOwner, cwd: string, instance: ITerminalInstance, external: boolean, cols: number, rows: number): Entry {
    const lifetime = new DisposableStore();
    const entry: Entry = { id, owner, cwd, instance, external, lifetime, history: [], paused: new Set(["consumer"]), historyLength: 0, sequence: 0, cols, rows, exited: false };
    this.entries.set(id, entry);
    this.instances.set(instance.instanceId, entry);
    instance.setSynaraOutputPaused(true);
    instance.setOverrideDimensions({ cols, rows });
    const output = (data: string) => {
      for (let offset = 0; offset < data.length; offset += 16_384) {
        const part = data.slice(offset, offset + 16_384);
        const sequence = ++entry.sequence;
        entry.history.push({ sequence, data: part });
        entry.historyLength += part.length;
        while (entry.historyLength > HISTORY_LIMIT && entry.history.length > 1) entry.historyLength -= entry.history.shift()!.data.length;
        this.emit({ kind: "data", id, data: part, sequence });
      }
    };
    // No await between taking the initial transcript and subscribing to live
    // data, so the same chunk cannot occur in both parts of the replay.
    for (const data of instance.initialDataEvents ?? []) output(data);
    lifetime.add(instance.onData(output));
    lifetime.add(instance.onExit((code) => this.exited(entry, typeof code === "number" ? code : 1)));
    lifetime.add(instance.onTitleChanged(() => {
      if (entry.external) this.emit({ kind: "external", terminal: this.external(entry, false) });
    }));
    return entry;
  }
  private exited(entry: Entry, exitCode: number): void {
    if (entry.exited) return;
    entry.exited = true;
    this.emit({ kind: "exit", id: entry.id, exitCode, signal: null });
  }

  private async spawn(request: DesktopPtySpawn): Promise<{ entry: Entry; reconnected: boolean }> {
    const previous = this.entries.get(request.id);
    if (previous && !previous.exited && !previous.instance.isDisposed) {
      if (previous.owner.threadId !== request.owner.threadId || previous.owner.terminalId !== request.owner.terminalId || previous.cwd !== request.cwd) throw new Error("This native terminal already belongs to a different Synara session or workspace.");
      previous.cols = request.cols;
      previous.rows = request.rows;
      previous.instance.setOverrideDimensions({ cols: request.cols, rows: request.rows });
      return { entry: previous, reconnected: true };
    }
    const pending = this.opening.get(request.id);
    if (pending) return { entry: await pending, reconnected: true };
    if (request.onlyExisting) throw new Error("The original native terminal no longer exists. It was not replaced with a new process.");
    const operation = (async () => {
      await this.terminals.whenConnected;
      const instance = await this.terminals.createTerminal({
        config: {
          name: "Synara terminal",
          executable: request.shell,
          args: typeof request.args === "string" ? request.args : [...request.args],
          cwd: request.cwd,
          env: { ...request.env },
          strictEnv: true,
          isTransient: true,
          isFeatureTerminal: true,
          ignoreConfigurationCwd: true,
          ignoreShellIntegration: true,
          reconnectionProperties: { ownerId: OWNER, data: { id: request.id, owner: request.owner } },
        },
      });
      const entry = this.bind(request.id, request.owner, request.cwd, instance, false, request.cols, request.rows);
      await instance.processReady;
      if (entry.exited || instance.isDisposed) throw new Error("The native terminal exited before it became ready.");
      return entry;
    })();
    this.opening.set(request.id, operation);
    try { return { entry: await operation, reconnected: false }; }
    finally { this.opening.delete(request.id); }
  }
  private snapshot(entry: Entry, reconnected: boolean, afterSequence?: number): DesktopPtySnapshot {
    const replay = reconnected ? entry.history.filter((chunk) => afterSequence === undefined || chunk.sequence > afterSequence).map((chunk) => chunk.data).join("") : "";
    // Startup output was already sent as events to the requesting backend. For
    // reconnects send only the requested tail; never replay already accepted input.
    return {
      id: entry.id, owner: entry.owner, pid: entry.instance.processId ?? null,
      cwd: entry.cwd, shell: entry.instance.shellLaunchConfig.executable ?? "",
      cols: entry.cols, rows: entry.rows, reconnected,
      history: replay.slice(-65_536), sequence: reconnected ? entry.sequence : 0,
      historyTruncated: replay.length > 65_536,
    };
  }

  async handle(request: DesktopPtyRequest): Promise<DesktopPtyReply> {
    if (request.kind === "list") return [...this.entries.values()].filter((entry) => entry.external && !entry.exited).map((entry) => this.external(entry, false));
    if (request.kind === "spawn") {
      const result = await this.spawn(request);
      return this.snapshot(result.entry, result.reconnected, request.afterSequence);
    }
    const entry = this.entries.get(request.id);
    if (!entry || entry.exited || entry.instance.isDisposed) {
      if (request.kind === "dispose" || request.kind === "resume") return null;
      throw new Error("This native terminal process is no longer available.");
    }
    switch (request.kind) {
      case "write": await entry.instance.writeSynaraRaw(request.data); break;
      case "resize":
        entry.cols = request.cols;
        entry.rows = request.rows;
        entry.instance.setOverrideDimensions({ cols: request.cols, rows: request.rows });
        break;
      case "signal":
        if (entry.instance.processId === undefined) entry.instance.dispose();
        else await entry.instance.sendSignal(request.signal);
        break;
      case "dispose": entry.instance.dispose(); break;
      case "pause":
        entry.paused.add(request.reason ?? "consumer");
        entry.instance.setSynaraOutputPaused(true);
        break;
      case "resume":
        entry.paused.delete(request.reason ?? "consumer");
        entry.instance.setSynaraOutputPaused(entry.paused.size > 0);
        break;
    }
    return null;
  }
  override dispose(): void {
    for (const entry of this.entries.values()) entry.lifetime.dispose();
    this.entries.clear();
    this.instances.clear();
    this.waitingExternal.clear();
    super.dispose();
  }
}

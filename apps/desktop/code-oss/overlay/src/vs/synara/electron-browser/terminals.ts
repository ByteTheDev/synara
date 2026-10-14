import { Disposable, DisposableStore } from "../../base/common/lifecycle.js";
import { ITerminalService, type ITerminalInstance } from "../../workbench/contrib/terminal/browser/terminal.js";
import { DESKTOP_IDE_MAX_CONTEXT, type DesktopIdeEvent, type DesktopIdeRequest, type DesktopIdeTerminalState } from "../common/desktopIde.js";

const HISTORY_LIMIT = 1024 * 1024;
const OWNER = "synara-existing-terminal";
type TerminalRequest = Extract<DesktopIdeRequest, { id: string; kind: `terminal.${string}` }>;
interface TerminalEntry {
  readonly id: string;
  readonly root: string;
  readonly instance: ITerminalInstance;
  readonly lifetime: DisposableStore;
  history: string;
  sequence: number;
  cols: number;
  rows: number;
  exited: boolean;
  exitCode: number | null;
}

/** No terminal panel is added: Synara's xterm renderer consumes the native PTY. */
export class SynaraTerminals extends Disposable {
  private readonly entries = new Map<string, TerminalEntry>();
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly terminals: ITerminalService, private readonly emit: (event: DesktopIdeEvent) => void) { super(); }

  async handle(request: TerminalRequest): Promise<DesktopIdeTerminalState | null> {
    const previous = this.tails.get(request.id) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.perform(request));
    this.tails.set(request.id, operation);
    void operation.finally(() => {
      if (this.tails.get(request.id) === operation) this.tails.delete(request.id);
    }).catch(() => undefined);
    return operation;
  }

  private snapshot(entry: TerminalEntry): DesktopIdeTerminalState {
    return {
      id: entry.id, root: entry.root, title: entry.instance.title,
      cols: entry.cols, rows: entry.rows, scrollback: entry.history,
      exited: entry.exited, exitCode: entry.exitCode, sequence: entry.sequence,
    };
  }
  private publish(entry: TerminalEntry): void {
    this.emit({ kind: "terminal.state", state: this.snapshot(entry) });
  }
  private bind(id: string, root: string, instance: ITerminalInstance, cols: number, rows: number): TerminalEntry {
    const lifetime = new DisposableStore();
    const entry: TerminalEntry = {
      id, root, instance, lifetime, cols, rows,
      history: (instance.initialDataEvents ?? []).join("").slice(-HISTORY_LIMIT),
      sequence: 0, exited: instance.exitReason !== undefined, exitCode: instance.exitCode ?? null,
    };
    this.entries.set(id, entry);
    lifetime.add(instance.onData((data) => {
      entry.history = (entry.history + data).slice(-HISTORY_LIMIT);
      // Keep individual IPC payloads bounded; sequence numbers let a reconnecting
      // renderer discard events already included in its authoritative snapshot.
      for (let offset = 0; offset < data.length; offset += DESKTOP_IDE_MAX_CONTEXT) {
        this.emit({ kind: "terminal.data", id, data: data.slice(offset, offset + DESKTOP_IDE_MAX_CONTEXT), sequence: ++entry.sequence });
      }
    }));
    lifetime.add(instance.onExit((code) => {
      entry.exited = true;
      entry.exitCode = typeof code === "number" ? code : null;
      this.publish(entry);
    }));
    lifetime.add(instance.onTitleChanged(() => this.publish(entry)));
    instance.setOverrideDimensions({ cols, rows });
    return entry;
  }
  private async open(request: Extract<TerminalRequest, { kind: "terminal.open" }>): Promise<TerminalEntry> {
    const existing = this.entries.get(request.id);
    if (existing) {
      // Selecting a different conversation/project never restarts or cd's a PTY.
      if (existing.root !== request.root) throw new Error("This terminal belongs to another workspace. Open a new terminal rather than replacing its running process.");
      return existing;
    }
    await this.terminals.whenConnected;
    const restored = this.terminals.getReconnectedTerminals(OWNER)?.find((instance) => {
      const data = instance.shellLaunchConfig.reconnectionProperties?.data as { id?: unknown; root?: unknown } | undefined;
      return data?.id === request.id && data.root === request.root;
    });
    const instance = restored ?? await this.terminals.createTerminal({
      config: {
        name: "Synara terminal", cwd: request.root, hideFromUser: true,
        reconnectionProperties: { ownerId: OWNER, data: { id: request.id, root: request.root } },
      },
    });
    const entry = this.bind(request.id, request.root, instance, request.cols, request.rows);
    await instance.processReady;
    this.publish(entry);
    return entry;
  }
  private async perform(request: TerminalRequest): Promise<DesktopIdeTerminalState | null> {
    if (request.kind === "terminal.open") return this.snapshot(await this.open(request));
    const entry = this.entries.get(request.id);
    if (!entry) throw new Error("This native terminal is not open. Reconnect it before sending input.");
    switch (request.kind) {
      case "terminal.snapshot": return this.snapshot(entry);
      case "terminal.write":
        if (entry.exited) throw new Error("This terminal process has exited.");
        // No newline insertion or bracketed-paste rewriting for xterm input.
        await entry.instance.sendText(request.data, false, false);
        return null;
      case "terminal.resize":
        entry.cols = request.cols;
        entry.rows = request.rows;
        entry.instance.setOverrideDimensions({ cols: request.cols, rows: request.rows });
        return null;
      case "terminal.clear":
        entry.instance.clearBuffer();
        entry.history = "";
        this.publish(entry);
        return null;
      case "terminal.close":
        // Only the existing terminal close action invokes this. Component
        // unmount and conversation changes do not dispose a terminal instance.
        entry.instance.dispose();
        entry.exited = true;
        entry.exitCode = entry.instance.exitCode ?? null;
        this.publish(entry);
        entry.lifetime.dispose();
        this.entries.delete(entry.id);
        return null;
    }
  }
  override dispose(): void {
    // Code-OSS owns process persistence and shutdown. This contribution only
    // releases subscriptions, never kills/restarts processes during UI teardown.
    for (const entry of this.entries.values()) entry.lifetime.dispose();
    this.entries.clear();
    super.dispose();
  }
}

import * as FS from "node:fs";
import * as Net from "node:net";
import {
  DESKTOP_PTY_CAPABILITY_FD, DESKTOP_PTY_CAPABILITY_FD_ENV, DESKTOP_PTY_PIPE_ENV,
  DESKTOP_PTY_MAX_FRAME, DESKTOP_PTY_PROTOCOL,
  isDesktopPtyEvent, isDesktopPtyExternal, isDesktopPtyRequest, isDesktopPtySnapshot,
  type DesktopPtyEvent, type DesktopPtyExternal, type DesktopPtyReply,
  type DesktopPtyRequest, type DesktopPtySnapshot, type DesktopPtySpawn,
} from "@synara/contracts";
import type { PtyExitEvent, PtyProcess, PtySpawnInput } from "./Services/PTY";

interface Pending {
  resolve(reply: DesktopPtyReply): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface Bootstrap { path: string; capability: string; }

function readBootstrap(): Bootstrap | null {
  const path = process.env[DESKTOP_PTY_PIPE_ENV];
  const rawFd = process.env[DESKTOP_PTY_CAPABILITY_FD_ENV];
  // The capability itself is never in an environment variable. Remove even
  // the routing hints before the backend can create any provider child.
  delete process.env[DESKTOP_PTY_PIPE_ENV];
  delete process.env[DESKTOP_PTY_CAPABILITY_FD_ENV];
  if (!path && !rawFd) return null;
  if (!path || rawFd !== String(DESKTOP_PTY_CAPABILITY_FD)) throw new Error("Invalid inherited native PTY transport.");
  let capability: string;
  try { capability = FS.readFileSync(DESKTOP_PTY_CAPABILITY_FD, "utf8").trim(); }
  finally { try { FS.closeSync(DESKTOP_PTY_CAPABILITY_FD); } catch { /* one-shot descriptor */ } }
  if (!/^[A-Za-z0-9_-]{43}$/u.test(capability)) throw new Error("Invalid inherited native PTY capability.");
  return { path, capability };
}

class NativePtyProcess implements PtyProcess {
  pid = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();
  private buffered: string[] = [];
  private bufferedLength = 0;
  private lastSequence = 0;
  private exit: PtyExitEvent | null = null;
  private paused = false;
  private ready = false;
  private pendingEvents: DesktopPtyEvent[] = [];

  constructor(readonly spawn: DesktopPtySpawn, private readonly client: NativePtyClient) {}

  initialize(snapshot: DesktopPtySnapshot): void {
    if (this.pid !== 0 && this.pid !== snapshot.pid) throw new Error("The native PTY identity changed; the running process was not replaced.");
    this.pid = snapshot.pid;
    if (snapshot.history) this.deliver(snapshot.history);
    this.lastSequence = snapshot.sequence;
    this.ready = true;
    const queued = this.pendingEvents;
    this.pendingEvents = [];
    for (const event of queued) this.receive(event);
  }
  receive(event: DesktopPtyEvent): void {
    if (!this.ready) {
      if (this.pendingEvents.length >= 2048) { this.reportError(new Error("Native terminal output overflowed during connection.")); return; }
      this.pendingEvents.push(event);
      return;
    }
    if (event.kind === "data") {
      if (event.sequence <= this.lastSequence) return;
      this.lastSequence = event.sequence;
      this.deliver(event.data);
    } else if (event.kind === "exit") {
      this.exit = { exitCode: event.exitCode, signal: event.signal };
      for (const listener of this.exitListeners) listener(this.exit);
      this.client.release(this.spawn.id, this);
    }
  }
  private deliver(data: string): void {
    if (this.dataListeners.size === 0) {
      this.bufferedLength += data.length;
      if (this.bufferedLength > DESKTOP_PTY_MAX_FRAME) {
        this.reportError(new Error("The native terminal produced more output than the startup buffer can hold."));
        this.pause();
        return;
      }
      this.buffered.push(data);
      return;
    }
    for (const listener of this.dataListeners) listener(data);
  }
  private control(request: DesktopPtyRequest): void {
    if (this.exit) throw new Error("The terminal process has exited.");
    void this.client.request(request).catch((error: unknown) => this.reportError(error instanceof Error ? error : new Error(String(error))));
  }
  write(data: string): void { this.control({ kind: "write", id: this.spawn.id, data }); }
  resize(cols: number, rows: number): void { this.control({ kind: "resize", id: this.spawn.id, cols, rows }); }
  kill(signal?: string): void {
    if (this.exit) return;
    this.control(signal ? { kind: "signal", id: this.spawn.id, signal } : { kind: "dispose", id: this.spawn.id });
  }
  pause(): void { this.paused = true; this.control({ kind: "pause", id: this.spawn.id }); }
  resume(): void { this.paused = false; this.control({ kind: "resume", id: this.spawn.id }); }
  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    queueMicrotask(() => {
      if (!this.dataListeners.has(listener)) return;
      const buffered = this.buffered;
      this.buffered = [];
      this.bufferedLength = 0;
      for (const data of buffered) listener(data);
      if (!this.paused && !this.exit) this.resume();
    });
    return () => this.dataListeners.delete(listener);
  }
  onExit(listener: (event: PtyExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    if (this.exit) queueMicrotask(() => { if (this.exitListeners.has(listener) && this.exit) listener(this.exit); });
    return () => this.exitListeners.delete(listener);
  }
  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }
  reportError(error: Error): void {
    // A transport failure is not evidence of process exit. Preserve the PID
    // and let the existing manager report an error rather than invent an exit.
    for (const listener of this.errorListeners) listener(error);
  }
  async reconnect(): Promise<void> {
    this.ready = false;
    const reply = await this.client.request({ ...this.spawn, onlyExisting: true, afterSequence: this.lastSequence });
    if (!isDesktopPtySnapshot(reply)) throw new Error("Invalid native PTY reconnect response.");
    this.initialize(reply);
    if (this.paused) this.pause(); else this.resume();
  }
}

export class NativePtyClient {
  private socket: Net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private nextRequest = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly processes = new Map<string, NativePtyProcess>();
  private readonly external = new Map<string, DesktopPtyExternal>();
  private readonly externalListeners = new Set<(terminal: DesktopPtyExternal) => void>();
  private retry: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly bootstrap: Bootstrap) {}

  private connect(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("The native PTY client is closed."));
    if (this.connecting) return this.connecting;
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    const operation = new Promise<void>((resolve, reject) => {
      const socket = Net.createConnection(this.bootstrap.path);
      let buffer = "";
      let authenticated = false;
      let failed = false;
      const deadline = setTimeout(() => socket.destroy(new Error("Native PTY connection timed out.")), 5_000);
      socket.setEncoding("utf8");
      const fail = (error: Error) => {
        if (failed) return;
        failed = true;
        clearTimeout(deadline);
        if (this.socket === socket) this.socket = null;
        socket.destroy();
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
        this.pending.clear();
        for (const process of this.processes.values()) process.reportError(error);
        reject(error);
        this.scheduleReconnect();
      };
      socket.on("error", fail);
      socket.on("close", () => fail(new Error("The native terminal connection closed. The running process was retained.")));
      socket.on("connect", () => socket.write(`${JSON.stringify({ kind: "hello", protocol: DESKTOP_PTY_PROTOCOL, capability: this.bootstrap.capability })}\n`));
      socket.on("data", (data: string) => {
        buffer += data;
        if (buffer.length > DESKTOP_PTY_MAX_FRAME * 2) { fail(new Error("Native PTY response exceeded its frame limit.")); return; }
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const raw = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let packet: Record<string, unknown>;
          try {
            if (Buffer.byteLength(raw, "utf8") > DESKTOP_PTY_MAX_FRAME) throw new Error("Oversized response");
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid response");
            packet = parsed as Record<string, unknown>;
          } catch { fail(new Error("The native PTY response was malformed.")); return; }
          if (!authenticated) {
            if (packet.kind !== "hello" || packet.protocol !== DESKTOP_PTY_PROTOCOL) { fail(new Error("Incompatible native PTY protocol.")); return; }
            authenticated = true;
            clearTimeout(deadline);
            this.socket = socket;
            resolve();
          } else this.receive(packet);
        }
      });
    });
    this.connecting = operation;
    void operation.finally(() => { if (this.connecting === operation) this.connecting = null; }).catch(() => undefined);
    return operation;
  }
  private scheduleReconnect(): void {
    if (this.retry || this.disposed || this.processes.size === 0) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.connect().then(async () => {
        for (const process of this.processes.values()) {
          try { await process.reconnect(); } catch (error) { process.reportError(error instanceof Error ? error : new Error(String(error))); }
        }
      }).catch(() => this.scheduleReconnect());
    }, 1_000);
    this.retry.unref?.();
  }
  private receive(packet: Record<string, unknown>): void {
    if (packet.kind === "event" && isDesktopPtyEvent(packet.event)) {
      const event = packet.event;
      if (event.kind === "external") {
        this.external.set(event.terminal.id, event.terminal);
        for (const listener of this.externalListeners) listener(event.terminal);
      } else this.processes.get(event.id)?.receive(event);
      return;
    }
    if (packet.kind !== "reply" || typeof packet.requestId !== "number") return;
    const pending = this.pending.get(packet.requestId);
    if (!pending) return;
    this.pending.delete(packet.requestId);
    clearTimeout(pending.timer);
    if (typeof packet.error === "string") pending.reject(new Error(packet.error.slice(0, 8192)));
    else if (packet.result === null || isDesktopPtySnapshot(packet.result) || (Array.isArray(packet.result) && packet.result.every(isDesktopPtyExternal))) pending.resolve(packet.result);
    else pending.reject(new Error("The native PTY returned an invalid result."));
  }
  async request(request: DesktopPtyRequest): Promise<DesktopPtyReply> {
    if (!isDesktopPtyRequest(request)) throw new Error("Invalid native PTY request.");
    await this.connect();
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new Error("The native PTY connection is unavailable.");
    if (this.pending.size >= 128) throw new Error("The native PTY request queue is full.");
    const requestId = ++this.nextRequest;
    const payload = `${JSON.stringify({ kind: "request", requestId, request })}\n`;
    if (Buffer.byteLength(payload, "utf8") > DESKTOP_PTY_MAX_FRAME || socket.writableLength > 4 * DESKTOP_PTY_MAX_FRAME) throw new Error("Native PTY input exceeded its bounded queue.");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("The native PTY operation timed out; no replacement process was started."));
      }, request.kind === "spawn" ? 30_000 : 10_000);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.write(payload, (error) => {
        if (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
      });
    });
  }
  async spawn(input: PtySpawnInput): Promise<PtyProcess> {
    if (!input.owner) throw new Error("Native terminal creation requires a Synara session owner.");
    const id = JSON.stringify([input.owner.threadId, input.owner.terminalId]);
    const existing = this.processes.get(id);
    if (existing) return existing;
    const env = Object.fromEntries(Object.entries(input.env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[0] !== DESKTOP_PTY_PIPE_ENV && entry[0] !== DESKTOP_PTY_CAPABILITY_FD_ENV));
    const request: DesktopPtySpawn = {
      kind: "spawn", id, owner: input.owner, shell: input.shell,
      args: input.windowsVerbatimArguments ? (input.args ?? []).join(" ") : (input.args ?? []),
      cwd: input.cwd, cols: input.cols, rows: input.rows, env,
    };
    const process = new NativePtyProcess(request, this);
    this.processes.set(id, process);
    try {
      const snapshot = await this.request(request);
      if (!isDesktopPtySnapshot(snapshot)) throw new Error("Invalid native terminal process response.");
      process.initialize(snapshot);
      return process;
    } catch (error) {
      this.processes.delete(id);
      throw error;
    }
  }
  release(id: string, process: NativePtyProcess): void { if (this.processes.get(id) === process) this.processes.delete(id); }
  subscribeExternal(listener: (terminal: DesktopPtyExternal) => void): () => void {
    this.externalListeners.add(listener);
    for (const terminal of this.external.values()) queueMicrotask(() => { if (this.externalListeners.has(listener)) listener(terminal); });
    void this.request({ kind: "list" }).then((result) => {
      if (Array.isArray(result)) for (const terminal of result) {
        if (!isDesktopPtyExternal(terminal)) continue;
        this.external.set(terminal.id, terminal);
        if (this.externalListeners.has(listener)) listener(terminal);
      }
    }).catch(() => undefined);
    return () => this.externalListeners.delete(listener);
  }
  dispose(): void {
    this.disposed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.socket?.destroy();
    this.socket = null;
    this.externalListeners.clear();
  }
}

// Captured at server startup, before provider environments are constructed.
let bootstrapError: Error | null = null;
let bootstrap: Bootstrap | null = null;
try { bootstrap = readBootstrap(); } catch (error) { bootstrapError = error instanceof Error ? error : new Error(String(error)); }
export const nativePtyClient = bootstrap ? new NativePtyClient(bootstrap) : null;
export function requireNativePtyBootstrap(): NativePtyClient | null {
  if (bootstrapError) throw bootstrapError;
  return nativePtyClient;
}

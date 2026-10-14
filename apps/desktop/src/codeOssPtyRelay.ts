import * as Crypto from "node:crypto";
import * as Net from "node:net";
import * as Path from "node:path";
import * as FS from "node:fs/promises";
import {
  DESKTOP_PTY_MAX_FRAME, DESKTOP_PTY_PROTOCOL,
  isDesktopPtyEvent, isDesktopPtyRequest,
  type DesktopPtyEvent, type DesktopPtyReply, type DesktopPtyRequest,
} from "@synara/contracts";
import { cleanupUnixPipe, ensureUnixPipeParent, resolveDefaultBrowserHostPipePath } from "./browserUsePipeServer";

interface Client {
  readonly socket: Net.Socket;
  authenticated: boolean;
  pending: string;
  inFlight: number;
  readonly ids: Set<string>;
  readonly paused: Set<string>;
  readonly deadline: ReturnType<typeof setTimeout>;
}

/** Transport only. Synara's TerminalManager still owns sessions, history, idle
 * checks, provider integration and parsed-output backpressure. Code-OSS owns
 * the actual PTYs and Extension Host terminal identities.
 */
export class CodeOssPtyRelay {
  readonly capability = Crypto.randomBytes(32).toString("base64url");
  readonly path = process.platform === "win32"
    ? `\\\\.\\pipe\\synara-native-pty-${process.pid}-${Crypto.randomUUID()}`
    : Path.join(Path.dirname(resolveDefaultBrowserHostPipePath()), `pty-${process.pid}-${Crypto.randomUUID()}.sock`);
  private readonly clients = new Set<Client>();
  private readonly server: Net.Server;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly options: {
    request(request: DesktopPtyRequest): Promise<DesktopPtyReply>;
    subscribe(listener: (event: DesktopPtyEvent) => void): () => void;
  }) {
    this.server = Net.createServer((socket) => this.accept(socket));
    this.server.on("error", () => {
      // No request payload, environment or private capability is logged.
      if (this.started) for (const client of this.clients) client.socket.destroy();
    });
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("The native PTY relay is closed.");
    if (this.started) return;
    if (process.platform !== "win32") ensureUnixPipeParent(this.path);
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { this.server.removeListener("listening", listening); reject(error); };
      const listening = () => { this.server.removeListener("error", failed); resolve(); };
      this.server.once("error", failed);
      this.server.once("listening", listening);
      this.server.listen(this.path);
    });
    this.started = true;
    if (process.platform !== "win32") await FS.chmod(this.path, 0o600);
    this.unsubscribe = this.options.subscribe((event) => this.publish(event));
  }

  private accept(socket: Net.Socket): void {
    if (this.closed || this.clients.size >= 8) { socket.destroy(); return; }
    socket.setEncoding("utf8");
    const client: Client = {
      socket, authenticated: false, pending: "", inFlight: 0, ids: new Set(), paused: new Set(),
      deadline: setTimeout(() => socket.destroy(), 5_000),
    };
    this.clients.add(client);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(client.deadline);
      this.clients.delete(client);
      // A backend restart does not discard PTYs. Release transport-only flow
      // control so native processes cannot stay frozen after a socket loss.
      for (const id of client.ids) void this.options.request({ kind: "resume", id }).catch(() => undefined);
    });
    socket.on("drain", () => {
      for (const id of client.paused) void this.options.request({ kind: "resume", id }).catch(() => undefined);
      client.paused.clear();
    });
    socket.on("data", (chunk: string) => {
      client.pending += chunk;
      if (client.pending.length > DESKTOP_PTY_MAX_FRAME * 2) { socket.destroy(); return; }
      let newline: number;
      while ((newline = client.pending.indexOf("\n")) >= 0) {
        const raw = client.pending.slice(0, newline);
        client.pending = client.pending.slice(newline + 1);
        if (Buffer.byteLength(raw, "utf8") > DESKTOP_PTY_MAX_FRAME) { socket.destroy(); return; }
        let packet: unknown;
        try { packet = JSON.parse(raw); } catch { socket.destroy(); return; }
        this.handle(client, packet);
        if (socket.destroyed) return;
      }
    });
  }

  private handle(client: Client, packet: unknown): void {
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) { client.socket.destroy(); return; }
    const data = packet as Record<string, unknown>;
    if (!client.authenticated) {
      const supplied = typeof data.capability === "string" ? Buffer.from(data.capability, "utf8") : Buffer.alloc(0);
      const expected = Buffer.from(this.capability, "utf8");
      if (data.kind !== "hello" || data.protocol !== DESKTOP_PTY_PROTOCOL || supplied.length !== expected.length || !Crypto.timingSafeEqual(supplied, expected)) {
        client.socket.destroy();
        return;
      }
      clearTimeout(client.deadline);
      client.authenticated = true;
      this.send(client, { kind: "hello", protocol: DESKTOP_PTY_PROTOCOL });
      return;
    }
    if (data.kind !== "request" || !Number.isSafeInteger(data.requestId) || !isDesktopPtyRequest(data.request) || client.inFlight >= 128) {
      client.socket.destroy();
      return;
    }
    const requestId = Number(data.requestId);
    const request = data.request;
    if (request.kind !== "spawn" && request.kind !== "list" && !client.ids.has(request.id)) {
      this.send(client, { kind: "reply", requestId, error: "This connection does not own the requested PTY." });
      return;
    }
    if (request.kind === "spawn") {
      if (!Path.isAbsolute(request.cwd)) {
        this.send(client, { kind: "reply", requestId, error: "Native PTYs require an absolute workspace directory." });
        return;
      }
      client.ids.add(request.id);
    }
    client.inFlight += 1;
    void this.options.request(request).then(
      (result) => this.send(client, { kind: "reply", requestId, result }),
      (error: unknown) => this.send(client, { kind: "reply", requestId, error: error instanceof Error ? error.message.slice(0, 8192) : "The native PTY operation failed." }),
    ).finally(() => { client.inFlight -= 1; });
  }

  private send(client: Client, packet: unknown): boolean {
    if (client.socket.destroyed) return false;
    const payload = `${JSON.stringify(packet)}\n`;
    if (Buffer.byteLength(payload, "utf8") > DESKTOP_PTY_MAX_FRAME || client.socket.writableLength > 4 * DESKTOP_PTY_MAX_FRAME) {
      client.socket.destroy(new Error("The native PTY transport exceeded its bounded output queue."));
      return false;
    }
    return client.socket.write(payload);
  }
  private publish(event: DesktopPtyEvent): void {
    if (!isDesktopPtyEvent(event)) return;
    for (const client of this.clients) {
      if (!client.authenticated || (event.kind !== "external" && !client.ids.has(event.id))) continue;
      const written = this.send(client, { kind: "event", event });
      if (!written && event.kind === "data" && !client.socket.destroyed && !client.paused.has(event.id)) {
        client.paused.add(event.id);
        void this.options.request({ kind: "pause", id: event.id }).catch(() => undefined);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const client of this.clients) client.socket.destroy();
    this.clients.clear();
    if (this.started) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (this.started && process.platform !== "win32") cleanupUnixPipe(this.path);
    this.started = false;
  }
}

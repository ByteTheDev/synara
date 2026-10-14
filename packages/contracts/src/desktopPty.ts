/** Private desktop-to-backend protocol. These operations are never exposed by the web preload. */
export const DESKTOP_PTY_PROTOCOL = 1;
export const DESKTOP_PTY_MAX_FRAME = 512 * 1024;
export const DESKTOP_PTY_PIPE_ENV = "SYNARA_NATIVE_PTY_PIPE";
export const DESKTOP_PTY_CAPABILITY_FD_ENV = "SYNARA_NATIVE_PTY_CAPABILITY_FD";
export const DESKTOP_PTY_CAPABILITY_FD = 4;

export interface DesktopPtyOwner {
  readonly threadId: string;
  readonly terminalId: string;
}
export interface DesktopPtySpawn {
  readonly kind: "spawn";
  readonly id: string;
  readonly owner: DesktopPtyOwner;
  readonly shell: string;
  readonly args: readonly string[] | string;
  readonly cwd: string;
  readonly cols: number;
  readonly rows: number;
  readonly env: Readonly<Record<string, string>>;
}
export type DesktopPtyRequest =
  | DesktopPtySpawn
  | { readonly kind: "write"; readonly id: string; readonly data: string }
  | { readonly kind: "resize"; readonly id: string; readonly cols: number; readonly rows: number }
  | { readonly kind: "signal"; readonly id: string; readonly signal: string }
  | { readonly kind: "pause" | "resume" | "dispose"; readonly id: string }
  | { readonly kind: "list" };
export interface DesktopPtySnapshot {
  readonly id: string;
  readonly owner: DesktopPtyOwner;
  readonly pid: number;
  readonly cwd: string;
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
  readonly reconnected: boolean;
  readonly history: string;
  readonly sequence: number;
}
export interface DesktopPtyExternal {
  readonly id: string;
  readonly owner: DesktopPtyOwner;
  readonly cwd: string;
  readonly title: string;
  readonly reveal: boolean;
}
export type DesktopPtyEvent =
  | { readonly kind: "data"; readonly id: string; readonly data: string; readonly sequence: number }
  | { readonly kind: "exit"; readonly id: string; readonly exitCode: number; readonly signal: number | null }
  | { readonly kind: "external"; readonly terminal: DesktopPtyExternal };
export type DesktopPtyReply = DesktopPtySnapshot | readonly DesktopPtyExternal[] | null;
export type DesktopPtyServerMessage =
  | { readonly kind: "reply"; readonly requestId: number; readonly result: DesktopPtyReply; readonly error?: never }
  | { readonly kind: "reply"; readonly requestId: number; readonly error: string; readonly result?: never }
  | { readonly kind: "event"; readonly event: DesktopPtyEvent };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.length > 0) && value.length <= max && !value.includes("\0");
}
function size(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}
export function isDesktopPtyOwner(value: unknown): value is DesktopPtyOwner {
  return record(value) && text(value.threadId, 512) && text(value.terminalId, 128);
}
export function isDesktopPtyRequest(value: unknown): value is DesktopPtyRequest {
  if (!record(value)) return false;
  if (value.kind === "list") return Object.keys(value).length === 1;
  if (!text(value.id, 1024)) return false;
  switch (value.kind) {
    case "spawn": {
      if (!isDesktopPtyOwner(value.owner) || !text(value.shell, 8192) || !text(value.cwd, 8192) ||
          !size(value.cols, 2, 2000) || !size(value.rows, 1, 1000) || !record(value.env)) return false;
      if (!(text(value.args, 65536, true) || (Array.isArray(value.args) && value.args.length <= 1024 && value.args.every((arg) => text(arg, 65536, true))))) return false;
      const entries = Object.entries(value.env);
      return entries.length <= 2048 && entries.every(([key, item]) => text(key, 1024) && text(item, 65536, true)) &&
        JSON.stringify(value).length < DESKTOP_PTY_MAX_FRAME / 2;
    }
    case "write": return typeof value.data === "string" && value.data.length <= 65536;
    case "resize": return size(value.cols, 2, 2000) && size(value.rows, 1, 1000);
    case "signal": return typeof value.signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(value.signal);
    case "pause": case "resume": case "dispose": return true;
    default: return false;
  }
}
export function isDesktopPtySnapshot(value: unknown): value is DesktopPtySnapshot {
  return record(value) && text(value.id, 1024) && isDesktopPtyOwner(value.owner) &&
    size(value.pid, 1, 0x7fffffff) && text(value.cwd, 8192) && text(value.shell, 8192, true) &&
    size(value.cols, 2, 2000) && size(value.rows, 1, 1000) && typeof value.reconnected === "boolean" &&
    typeof value.history === "string" && value.history.length <= DESKTOP_PTY_MAX_FRAME / 4 &&
    size(value.sequence, 0, Number.MAX_SAFE_INTEGER);
}
export function isDesktopPtyExternal(value: unknown): value is DesktopPtyExternal {
  return record(value) && text(value.id, 1024) && isDesktopPtyOwner(value.owner) &&
    text(value.cwd, 8192) && text(value.title, 1024, true) && typeof value.reveal === "boolean";
}
export function isDesktopPtyEvent(value: unknown): value is DesktopPtyEvent {
  if (!record(value)) return false;
  if (value.kind === "external") return isDesktopPtyExternal(value.terminal);
  if (!text(value.id, 1024)) return false;
  if (value.kind === "data") return typeof value.data === "string" && value.data.length <= 65536 && size(value.sequence, 0, Number.MAX_SAFE_INTEGER);
  return value.kind === "exit" && size(value.exitCode, -0x7fffffff, 0x7fffffff) &&
    (value.signal === null || size(value.signal, 0, 128));
}

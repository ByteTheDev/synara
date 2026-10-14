/** Capability-limited bridge to Code-OSS inside Synara's existing editor. */
export const DESKTOP_IDE_PROTOCOL = 2;
export const DESKTOP_IDE_MAX_CONTEXT = 64 * 1024;
export const DESKTOP_IDE_MAX_BUFFER = 8 * 1024 * 1024;

export interface DesktopIdeScope {
  readonly threadId: string | null;
  readonly projectId: string | null;
  readonly roots: readonly string[];
}
export interface DesktopIdeState {
  readonly protocol: typeof DESKTOP_IDE_PROTOCOL;
  readonly status: "unavailable" | "starting" | "ready" | "error";
  readonly scope: DesktopIdeScope;
  readonly generation: number;
  readonly message: string | null;
  readonly appearance?: DesktopIdeAppearance;
}
export interface DesktopIdeContext {
  readonly threadId: string;
  readonly generation: number;
  readonly kind: "selection" | "diagnostics" | "terminal" | "debug";
  readonly title: string;
  readonly text: string;
}
export interface DesktopIdeDocument {
  readonly root: string;
  readonly path: string;
}
export interface DesktopIdeBuffer {
  readonly value: string;
  readonly baseline: string;
  readonly expectedVersion: string;
  readonly encoding: "utf8" | "utf8-bom" | "utf16le" | "utf16be";
}
export interface DesktopIdeDocumentState extends DesktopIdeDocument {
  readonly revision: number;
  readonly value: string;
  readonly baseline: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly conflict: boolean;
  readonly error: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}
/** A lease identifies a mounted existing surface. Stale cleanup cannot hide its replacement. */
export interface DesktopIdeSurface {
  readonly lease: string;
  readonly visible: boolean;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly blocked: boolean;
}
export const DESKTOP_IDE_COMMANDS = [
  "suggest", "definition", "references", "rename", "format", "commands",
  "debugStart", "debugStop", "debugContinue", "debugPause", "debugStepOver",
  "debugStepInto", "debugStepOut", "debugRestart", "debugConsole", "debugConfigure",
  "breakpoint", "problems", "extensions", "sendSelection", "sendDiagnostics",
] as const;
export type DesktopIdeCommand = (typeof DESKTOP_IDE_COMMANDS)[number];
export type DesktopIdeRequest =
  | { readonly kind: "editor.open"; readonly document: DesktopIdeDocument; readonly initial?: DesktopIdeBuffer }
  | { readonly kind: "editor.show"; readonly document: DesktopIdeDocument; readonly line?: number; readonly column?: number }
  | { readonly kind: "editor.edit"; readonly document: DesktopIdeDocument; readonly revision: number; readonly value: string }
  | { readonly kind: "editor.save"; readonly document: DesktopIdeDocument; readonly overwrite?: boolean }
  | { readonly kind: "editor.revert" | "editor.undo" | "editor.redo" | "editor.release"; readonly document: DesktopIdeDocument }
  | { readonly kind: "editor.command"; readonly command: DesktopIdeCommand }
  | { readonly kind: "editor.diff"; readonly document: DesktopIdeDocument; readonly original: string; readonly title: string }
  | { readonly kind: "terminal.open"; readonly id: string; readonly root: string; readonly cols: number; readonly rows: number }
  | { readonly kind: "terminal.write"; readonly id: string; readonly data: string }
  | { readonly kind: "terminal.resize"; readonly id: string; readonly cols: number; readonly rows: number }
  | { readonly kind: "terminal.close" | "terminal.clear" | "terminal.snapshot"; readonly id: string }
  | { readonly kind: "git.stage" | "git.unstage"; readonly root: string; readonly paths: readonly string[] }
  | { readonly kind: "extensions.list" }
  | { readonly kind: "extensions.install" | "extensions.uninstall"; readonly id: string };
export interface DesktopIdeTerminalState {
  readonly id: string;
  readonly root: string;
  readonly title: string;
  readonly cols: number;
  readonly rows: number;
  readonly scrollback: string;
  readonly exited: boolean;
  readonly exitCode: number | null;
  readonly sequence: number;
}
export interface DesktopIdeExtension {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly builtin: boolean;
}
export type DesktopIdeReply =
  | DesktopIdeDocumentState
  | DesktopIdeTerminalState
  | readonly DesktopIdeExtension[]
  | null;
export type DesktopIdeEvent =
  | { readonly kind: "editor.state"; readonly state: DesktopIdeDocumentState }
  | { readonly kind: "editor.reveal"; readonly document: DesktopIdeDocument; readonly line?: number; readonly column?: number }
  | { readonly kind: "terminal.data"; readonly id: string; readonly data: string; readonly sequence: number }
  | { readonly kind: "terminal.state"; readonly state: DesktopIdeTerminalState }
  | { readonly kind: "git.changed"; readonly root: string }
  | { readonly kind: "debug.state"; readonly state: "inactive" | "initializing" | "running" | "stopped" }
  | { readonly kind: "surface.blocked"; readonly blocked: boolean };
export interface DesktopIdeBridge {
  getState(): Promise<DesktopIdeState>;
  setScope(scope: DesktopIdeScope): Promise<void>;
  setAppearance(appearance: DesktopIdeAppearance): Promise<void>;
  setSurface(surface: DesktopIdeSurface): Promise<void>;
  releaseSurface(lease: string): Promise<void>;
  request(request: DesktopIdeRequest): Promise<DesktopIdeReply>;
  prepareQuit(requestId: string): Promise<boolean>;
  onState(listener: (state: DesktopIdeState) => void): () => void;
  onEvent(listener: (event: DesktopIdeEvent) => void): () => void;
  onContext(listener: (context: DesktopIdeContext) => void): () => void;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function text(value: unknown, max: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.length > 0) && value.length <= max && !value.includes("\0");
}
function integer(value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function isDesktopIdeScope(value: unknown): value is DesktopIdeScope {
  if (!record(value)) return false;
  return (value.threadId === null || text(value.threadId, 512)) &&
    (value.projectId === null || text(value.projectId, 512)) &&
    Array.isArray(value.roots) && value.roots.length <= 16 &&
    value.roots.every((root) => text(root, 8192));
}
export function isDesktopIdeDocument(value: unknown): value is DesktopIdeDocument {
  return record(value) && text(value.root, 8192) && text(value.path, 8192);
}
export function isDesktopIdeBuffer(value: unknown): value is DesktopIdeBuffer {
  return record(value) && typeof value.value === "string" && value.value.length <= DESKTOP_IDE_MAX_BUFFER &&
    typeof value.baseline === "string" && value.baseline.length <= DESKTOP_IDE_MAX_BUFFER &&
    typeof value.expectedVersion === "string" && /^sha256:[a-f0-9]{64}$/u.test(value.expectedVersion) &&
    ["utf8", "utf8-bom", "utf16le", "utf16be"].includes(String(value.encoding));
}
export function isDesktopIdeDocumentState(value: unknown): value is DesktopIdeDocumentState {
  if (!record(value) || !isDesktopIdeDocument(value)) return false;
  return integer(value.revision, 0) && typeof value.value === "string" &&
    value.value.length <= DESKTOP_IDE_MAX_BUFFER && typeof value.baseline === "string" &&
    value.baseline.length <= DESKTOP_IDE_MAX_BUFFER &&
    [value.dirty, value.saving, value.conflict, value.canUndo, value.canRedo].every((item) => typeof item === "boolean") &&
    (value.error === null || text(value.error, 8192, true));
}
export function isDesktopIdeSurface(value: unknown): value is DesktopIdeSurface {
  if (!record(value) || !text(value.lease, 128)) return false;
  return typeof value.visible === "boolean" && typeof value.blocked === "boolean" &&
    [value.x, value.y, value.width, value.height].every((item) =>
      typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 100_000);
}
export function isDesktopIdeRequest(value: unknown): value is DesktopIdeRequest {
  if (!record(value)) return false;
  switch (value.kind) {
    case "editor.open": return isDesktopIdeDocument(value.document) && (value.initial === undefined || isDesktopIdeBuffer(value.initial));
    case "editor.show": return isDesktopIdeDocument(value.document) &&
      (value.line === undefined || integer(value.line, 1)) && (value.column === undefined || integer(value.column, 1));
    case "editor.edit": return isDesktopIdeDocument(value.document) && integer(value.revision, 0) &&
      typeof value.value === "string" && value.value.length <= DESKTOP_IDE_MAX_BUFFER;
    case "editor.save": return isDesktopIdeDocument(value.document) &&
      (value.overwrite === undefined || typeof value.overwrite === "boolean");
    case "editor.revert": case "editor.undo": case "editor.redo": case "editor.release":
      return isDesktopIdeDocument(value.document);
    case "editor.command": return DESKTOP_IDE_COMMANDS.some((command) => command === value.command);
    case "editor.diff": return isDesktopIdeDocument(value.document) &&
      typeof value.original === "string" && value.original.length <= DESKTOP_IDE_MAX_BUFFER && text(value.title, 1024);
    case "terminal.open": return text(value.id, 512) && text(value.root, 8192) &&
      integer(value.cols, 2, 1000) && integer(value.rows, 1, 1000);
    case "terminal.resize": return text(value.id, 512) && integer(value.cols, 2, 1000) && integer(value.rows, 1, 1000);
    case "terminal.write": return text(value.id, 512) && typeof value.data === "string" && value.data.length <= DESKTOP_IDE_MAX_CONTEXT;
    case "terminal.close": case "terminal.clear": case "terminal.snapshot": return text(value.id, 512);
    case "git.stage": case "git.unstage": return text(value.root, 8192) && Array.isArray(value.paths) &&
      value.paths.length > 0 && value.paths.length <= 1000 && value.paths.every((path) => text(path, 8192));
    case "extensions.list": return true;
    case "extensions.install": case "extensions.uninstall": return typeof value.id === "string" &&
      value.id.length <= 256 && /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu.test(value.id);
    default: return false;
  }
}
export function isDesktopIdeContext(value: unknown): value is DesktopIdeContext {
  return record(value) && text(value.threadId, 512) && integer(value.generation, 0) &&
    ["selection", "diagnostics", "terminal", "debug"].includes(String(value.kind)) &&
    text(value.title, 512, true) && text(value.text, DESKTOP_IDE_MAX_CONTEXT);
}

/** Only presentation tokens cross this bridge, never arbitrary CSS or settings. */
export const DESKTOP_IDE_APPEARANCE_COLORS = [
  "surface", "shell", "raised", "input", "foreground", "muted", "subtle", "border", "focus",
  "accent", "button", "buttonHover", "onAccent", "selection", "hover", "danger", "warning",
  "success", "diffAdded", "diffRemoved",
] as const;
export interface DesktopIdeAppearance {
  readonly variant: "light" | "dark";
  readonly colors: Readonly<Record<(typeof DESKTOP_IDE_APPEARANCE_COLORS)[number], string>>;
  readonly uiFontFamily: string;
  readonly uiFontSize: number;
  readonly radius: number;
}
export function isDesktopIdeAppearance(value: unknown): value is DesktopIdeAppearance {
  if (!record(value)) return false;
  const colors = value.colors;
  return (value.variant === "light" || value.variant === "dark") &&
    text(value.uiFontFamily, 512) && !/[;{}<>\\\r\n]|url\s*\(/iu.test(value.uiFontFamily) &&
    typeof value.uiFontSize === "number" && Number.isFinite(value.uiFontSize) && value.uiFontSize >= 9 && value.uiFontSize <= 32 &&
    typeof value.radius === "number" && Number.isFinite(value.radius) && value.radius >= 0 && value.radius <= 24 &&
    record(colors) && Object.keys(colors).length === DESKTOP_IDE_APPEARANCE_COLORS.length &&
    DESKTOP_IDE_APPEARANCE_COLORS.every((key) => typeof colors[key] === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(colors[key]));
}

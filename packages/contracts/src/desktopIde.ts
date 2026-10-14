/** Versioned, capability-limited bridge between Synara and its native Code-OSS workbench. */
export const DESKTOP_IDE_PROTOCOL = 2;
export const DESKTOP_IDE_MAX_CONTEXT = 64 * 1024;
export interface DesktopIdeScope {
  readonly threadId: string | null;
  readonly projectId: string | null;
  readonly roots: readonly string[];
}
export interface DesktopIdeState {
  readonly protocol: 2;
  readonly status: "unavailable" | "starting" | "ready" | "error";
  readonly surfaceId: string | null;
  readonly editor: DesktopEditorState | null;
  readonly scope: DesktopIdeScope;
  readonly generation: number;
  readonly attention: number;
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
export interface DesktopIdeBridge {
  getState(): Promise<DesktopIdeState>;
  setSurface(surface: DesktopEditorSurface): Promise<void>;
  editor(request: DesktopEditorRequest): Promise<DesktopEditorResult>;
  onNavigate(listener: (target: "files" | "changes" | "search") => void): () => void;
  onSaved(listener: (resource: string) => void): () => void;
  setScope(scope: DesktopIdeScope): Promise<void>;
  setAttention(count: number): Promise<void>;
  setAppearance(appearance: DesktopIdeAppearance): Promise<void>;
  prepareQuit(requestId: string): Promise<boolean>;
  onState(listener: (state: DesktopIdeState) => void): () => void;
  onContext(listener: (context: DesktopIdeContext) => void): () => void;
}

export function isDesktopIdeScope(value: unknown): value is DesktopIdeScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  const identifier = (id: unknown) =>
    id === null || (typeof id === "string" && id.length > 0 && id.length <= 512);
  return (
    identifier(scope.threadId) &&
    identifier(scope.projectId) &&
    Array.isArray(scope.roots) &&
    scope.roots.length <= 16 &&
    scope.roots.every(
      (root) =>
        typeof root === "string" && root.length > 0 && root.length <= 8192 && !root.includes("\0"),
    )
  );
}

export function isDesktopIdeContext(value: unknown): value is DesktopIdeContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Record<string, unknown>;
  return (
    typeof context.threadId === "string" &&
    context.threadId.length > 0 &&
    context.threadId.length <= 512 &&
    Number.isSafeInteger(context.generation) &&
    Number(context.generation) >= 0 &&
    typeof context.kind === "string" &&
    ["selection", "diagnostics", "terminal", "debug"].includes(context.kind) &&
    typeof context.title === "string" &&
    context.title.length <= 512 &&
    typeof context.text === "string" &&
    context.text.length > 0 &&
    context.text.length <= DESKTOP_IDE_MAX_CONTEXT
  );
}

/** Only presentation tokens cross this bridge, never arbitrary CSS or settings. */
export const DESKTOP_IDE_APPEARANCE_COLORS = [
  "surface",
  "shell",
  "raised",
  "input",
  "foreground",
  "muted",
  "subtle",
  "border",
  "focus",
  "accent",
  "button",
  "buttonHover",
  "onAccent",
  "selection",
  "hover",
  "danger",
  "warning",
  "success",
  "diffAdded",
  "diffRemoved",
] as const;
export interface DesktopIdeAppearance {
  readonly variant: "light" | "dark";
  readonly colors: Readonly<Record<(typeof DESKTOP_IDE_APPEARANCE_COLORS)[number], string>>;
  readonly uiFontFamily: string;
  readonly uiFontSize: number;
  readonly radius: number;
}
export function isDesktopIdeAppearance(value: unknown): value is DesktopIdeAppearance {
  if (!value || typeof value !== "object") return false;
  const appearance = value as Record<string, unknown>;
  const colors = appearance.colors;
  return (
    (appearance.variant === "light" || appearance.variant === "dark") &&
    typeof appearance.uiFontFamily === "string" &&
    appearance.uiFontFamily.length > 0 &&
    appearance.uiFontFamily.length <= 512 &&
    !/[;{}<>\\\r\n\0]|url\s*\(/iu.test(appearance.uiFontFamily) &&
    typeof appearance.uiFontSize === "number" &&
    Number.isFinite(appearance.uiFontSize) &&
    appearance.uiFontSize >= 9 &&
    appearance.uiFontSize <= 32 &&
    typeof appearance.radius === "number" &&
    Number.isFinite(appearance.radius) &&
    appearance.radius >= 0 &&
    appearance.radius <= 24 &&
    colors !== null &&
    typeof colors === "object" &&
    !Array.isArray(colors) &&
    Object.keys(colors).length === DESKTOP_IDE_APPEARANCE_COLORS.length &&
    DESKTOP_IDE_APPEARANCE_COLORS.every((key) => {
      const color = (colors as Record<string, unknown>)[key];
      return typeof color === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(color);
    })
  );
}

/** Geometry only: the existing Synara editor owns the viewport and its chrome. */
export interface DesktopEditorSurface {
  readonly id: string;
  readonly occluded?: boolean;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null;
}
export interface DesktopEditorState {
  readonly resource: string | null;
  readonly name: string;
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly dirtyResources: readonly string[];
}
export const DESKTOP_EDITOR_ACTIONS = [
  "save", "close", "undo", "redo", "revert", "format", "terminal", "new-terminal",
  "debug", "extensions", "problems", "commands", "toggle-diff",
] as const;
export type DesktopEditorAction = (typeof DESKTOP_EDITOR_ACTIONS)[number];
export type DesktopEditorRequest = {
  readonly surfaceId: string;
  readonly generation: number;
} & (
  | { readonly kind: "open"; readonly root: string; readonly path: string;
      readonly original?: { readonly contents: string; readonly label: string } }
  | { readonly kind: DesktopEditorAction; readonly resource: string | null }
);
export interface DesktopEditorResult { readonly closed?: boolean; readonly resource?: string }
const editorId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
const editorPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 8192 && !value.includes("\0");
export function isDesktopEditorSurface(value: unknown): value is DesktopEditorSurface {
  if (!value || typeof value !== "object") return false;
  const surface = value as Record<string, unknown>;
  if (!editorId(surface.id) || (surface.occluded !== undefined && typeof surface.occluded !== "boolean")) return false;
  if (surface.bounds === null) return true;
  if (!surface.bounds || typeof surface.bounds !== "object") return false;
  const rect = surface.bounds as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) =>
    typeof rect[key] === "number" && Number.isFinite(rect[key]) && Number(rect[key]) >= 0 && Number(rect[key]) < 100000,
  );
}
export function isDesktopEditorRequest(value: unknown): value is DesktopEditorRequest {
  if (!value || typeof value !== "object") return false;
  const input = value as Record<string, unknown>;
  if (!editorId(input.surfaceId) || !Number.isSafeInteger(input.generation) || Number(input.generation) < 0) return false;
  if (input.kind === "open") {
    if (!editorPath(input.root) || !editorPath(input.path)) return false;
    // OS-aware canonical containment is additionally enforced in Electron main.
    if (/^(?:[a-z]:|[\\/])/iu.test(input.path) || input.path.split(/[\\/]/u).includes("..")) return false;
    if (input.original === undefined) return true;
    if (!input.original || typeof input.original !== "object") return false;
    const original = input.original as Record<string, unknown>;
    return typeof original.contents === "string" && original.contents.length <= 8 * 1024 * 1024 && editorId(original.label);
  }
  return typeof input.kind === "string" && (DESKTOP_EDITOR_ACTIONS as readonly string[]).includes(input.kind) &&
    (input.resource === null || editorPath(input.resource));
}
export function isDesktopEditorState(value: unknown): value is DesktopEditorState {
  if (!value || typeof value !== "object") return false;
  const editor = value as Record<string, unknown>;
  return (editor.resource === null || editorPath(editor.resource)) && typeof editor.name === "string" && editor.name.length <= 8192 &&
    ["dirty", "saving", "canUndo", "canRedo"].every((key) => typeof editor[key] === "boolean") &&
    Array.isArray(editor.dirtyResources) && editor.dirtyResources.length <= 10000 && editor.dirtyResources.every(editorPath);
}

/** Versioned, capability-limited bridge between Synara and its native Code-OSS workbench. */
export const DESKTOP_IDE_PROTOCOL = 1;
export const DESKTOP_IDE_MAX_CONTEXT = 64 * 1024;
export type DesktopIdeMode = "agent" | "ide";
export interface DesktopIdeScope {
  readonly threadId: string | null;
  readonly projectId: string | null;
  readonly roots: readonly string[];
}
export interface DesktopIdeState {
  readonly protocol: 1;
  readonly status: "unavailable" | "starting" | "ready" | "error";
  readonly mode: DesktopIdeMode;
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
  setMode(mode: DesktopIdeMode): Promise<DesktopIdeState>;
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

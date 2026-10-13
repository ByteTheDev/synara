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
  prepareQuit(requestId: string): Promise<boolean>;
  onState(listener: (state: DesktopIdeState) => void): () => void;
  onContext(listener: (context: DesktopIdeContext) => void): () => void;
}

export function isDesktopIdeScope(value: unknown): value is DesktopIdeScope {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  const identifier = (id: unknown) => id === null || (typeof id === "string" && id.length > 0 && id.length <= 512);
  return identifier(scope.threadId) && identifier(scope.projectId) && Array.isArray(scope.roots) &&
    scope.roots.length <= 16 && scope.roots.every(root => typeof root === "string" && root.length > 0 && root.length <= 8192 && !root.includes("\0"));
}

export function isDesktopIdeContext(value: unknown): value is DesktopIdeContext {
  if (!value || typeof value !== "object") return false;
  const context = value as Record<string, unknown>;
  return typeof context.threadId === "string" && context.threadId.length > 0 && context.threadId.length <= 512 &&
    Number.isSafeInteger(context.generation) && Number(context.generation) >= 0 &&
    typeof context.kind === "string" && ["selection", "diagnostics", "terminal", "debug"].includes(context.kind) &&
    typeof context.title === "string" && context.title.length <= 512 &&
    typeof context.text === "string" && context.text.length > 0 && context.text.length <= DESKTOP_IDE_MAX_CONTEXT;
}

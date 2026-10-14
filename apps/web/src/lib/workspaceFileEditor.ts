import type { DesktopIdeDocumentState, ProjectFileEncoding, ProjectFileLineEnding } from "@synara/contracts";

/** On-disk format of a loaded buffer; every legacy save re-encodes with it. */
export interface WorkspaceFileEditorFormat {
  expectedVersion: string;
  encoding: ProjectFileEncoding;
  lineEnding: Exclude<ProjectFileLineEnding, "mixed">;
}
export interface WorkspaceFileEditorSource {
  truncated: boolean;
  version: string | null;
  encoding: ProjectFileEncoding | null;
  lineEnding: ProjectFileLineEnding | null;
  symlink?: boolean | undefined;
}
export interface WorkspaceFileEditorState {
  key: string | null;
  baseline: string;
  value: string;
  version: number;
  format: WorkspaceFileEditorFormat | null;
  conflict: boolean;
  saving: boolean;
  saveError: string | null;
  /** Present only after a successful ownership handoff to the native model. */
  native?: DesktopIdeDocumentState;
}
export type WorkspaceFileEditorAction =
  | { type: "loaded"; key: string; contents: string; format: WorkspaceFileEditorFormat }
  | { type: "reloaded"; key: string; contents: string; format: WorkspaceFileEditorFormat }
  | { type: "changed"; value: string }
  | { type: "nativeUpdated"; key: string; state: DesktopIdeDocumentState }
  | { type: "saveStarted" }
  | { type: "saveSucceeded"; contents: string; expectedVersion: string }
  | { type: "saveFailed"; message: string; conflict: boolean }
  | { type: "closed" };
export const INITIAL_WORKSPACE_FILE_EDITOR_STATE: WorkspaceFileEditorState = {
  key: null, baseline: "", value: "", version: 0, format: null,
  conflict: false, saving: false, saveError: null,
};

export function resolveWorkspaceFileEditorReadOnlyReason(source: WorkspaceFileEditorSource): string | null {
  if (source.truncated) return "Large files are read-only.";
  if (source.symlink) return "Symbolic links are read-only; edit the file they point to instead.";
  if (source.lineEnding === "mixed") return "Files with mixed line endings are read-only to preserve their exact format.";
  if (source.version === null || source.encoding === null || source.lineEnding === null) return "This file format is read-only.";
  return null;
}
export function resolveWorkspaceFileEditorFormat(source: WorkspaceFileEditorSource): WorkspaceFileEditorFormat | null {
  if (source.truncated || source.symlink || source.version === null || source.encoding === null || source.lineEnding === null || source.lineEnding === "mixed") return null;
  return { expectedVersion: source.version, encoding: source.encoding, lineEnding: source.lineEnding };
}
export function isWorkspaceFileEditorDirty(state: WorkspaceFileEditorState): boolean {
  return state.key !== null && (state.native ? state.native.dirty : state.value !== state.baseline);
}
function replaceBuffer(state: WorkspaceFileEditorState, key: string, contents: string, format: WorkspaceFileEditorFormat): WorkspaceFileEditorState {
  return { key, baseline: contents, value: contents, version: state.version + 1, format, conflict: false, saving: false, saveError: null };
}
export function workspaceFileEditorReducer(state: WorkspaceFileEditorState, action: WorkspaceFileEditorAction): WorkspaceFileEditorState {
  switch (action.type) {
    case "loaded": {
      // Once native owns a resource, its file watcher, working-copy model and
      // save/conflict state are authoritative. A stale server read cannot win.
      if (state.key === action.key && (state.native || isWorkspaceFileEditorDirty(state))) return state;
      if (state.key === action.key && state.baseline === action.contents && state.format?.expectedVersion === action.format.expectedVersion) return state;
      return replaceBuffer(state, action.key, action.contents, action.format);
    }
    case "reloaded": return replaceBuffer(state, action.key, action.contents, action.format);
    case "changed":
      return state.key === null || state.value === action.value || state.native
        ? state : { ...state, value: action.value };
    case "nativeUpdated":
      if (state.native && action.state.revision <= state.native.revision) return state;
      return {
        ...state, key: action.key, value: action.state.value, baseline: action.state.baseline,
        version: state.value === action.state.value ? state.version : state.version + 1,
        native: action.state, saving: action.state.saving, conflict: action.state.conflict,
        saveError: action.state.error,
      };
    case "saveStarted": return state.saving ? state : { ...state, saving: true, saveError: null };
    case "saveSucceeded":
      return { ...state, baseline: action.contents, format: state.format ? { ...state.format, expectedVersion: action.expectedVersion } : null, saving: false, conflict: false, saveError: null };
    case "saveFailed": return { ...state, saving: false, conflict: action.conflict, saveError: action.message };
    case "closed": return state.key === null ? state : INITIAL_WORKSPACE_FILE_EDITOR_STATE;
  }
}
export function workspaceFileEditorKey(cwd: string | null, filePath: string | null): string | null {
  return cwd === null || filePath === null ? null : `${cwd}\u0000${filePath}`;
}

import type { DesktopIdeBridge, DesktopIdeDocument, DesktopIdeDocumentState, ProjectReadFileResult } from "@synara/contracts";
import { isWorkspaceFileWriteConflictError } from "@synara/shared/workspaceFileWrite";
import type { QueryClient } from "@tanstack/react-query";
import { ensureNativeApi } from "~/nativeApi";
import { requireCodeOssDocument } from "./desktopIdeBridge";
import { refreshGitAfterFileWrite } from "./gitReactQuery";
import { projectQueryKeys, projectReadFileQueryOptions } from "./projectReactQuery";
import {
  INITIAL_WORKSPACE_FILE_EDITOR_STATE, isWorkspaceFileEditorDirty,
  resolveWorkspaceFileEditorFormat, workspaceFileEditorKey, workspaceFileEditorReducer,
  type WorkspaceFileEditorAction,
} from "./workspaceFileEditor";

export const WORKSPACE_EDITOR_AUTOSAVE_MS = 400;
const sessions = new WeakMap<QueryClient, Map<string, WorkspaceEditorSession>>();

/** One canonical session and one writer per file across all existing surfaces. */
export class WorkspaceEditorSession {
  private state = INITIAL_WORKSPACE_FILE_EDITOR_STATE;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<boolean> | undefined;
  private paused = false;
  private editGeneration = 0;
  private native: DesktopIdeBridge | null = null;
  private nativeSubscription: (() => void) | null = null;
  private attaching: Promise<void> | null = null;
  private nativeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly client: QueryClient, readonly cwd: string, readonly relativePath: string, private readonly release: () => void) {}
  getSnapshot = () => this.state;
  get document(): DesktopIdeDocument { return { root: this.cwd, path: this.relativePath }; }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.clearTimer();
      queueMicrotask(() => this.releaseIfUnused());
    };
  };
  private releaseIfUnused() {
    if (this.listeners.size === 0 && !this.writing && !this.attaching && !this.dirty) {
      this.nativeSubscription?.();
      this.nativeSubscription = null;
      this.release();
    }
  }
  get saving() { return this.writing !== undefined || this.state.saving; }
  get dirty() { return isWorkspaceFileEditorDirty(this.state); }
  private dispatch(action: WorkspaceFileEditorAction) {
    const next = workspaceFileEditorReducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  load(file: ProjectReadFileResult) {
    const format = resolveWorkspaceFileEditorFormat(file);
    if (!format || this.writing || this.native || this.attaching) return;
    this.dispatch({ type: "loaded", key: workspaceFileEditorKey(this.cwd, this.relativePath)!, contents: file.contents, format });
  }
  private receiveNative = (state: DesktopIdeDocumentState) => {
    if (state.root !== this.cwd || state.path !== this.relativePath) return;
    this.dispatch({ type: "nativeUpdated", key: workspaceFileEditorKey(this.cwd, this.relativePath)!, state });
    if (this.listeners.size > 0) this.schedule();
  };

  /** Finish any accepted legacy write, then transfer the actual unsaved contents.
   * No native surface becomes interactive until ownership has been acknowledged.
   * Incompatible CR-only files retain the existing exact-format writer.
   */
  attachNative(bridge: DesktopIdeBridge): Promise<void> {
    if (this.native || !this.state.format || this.state.format.lineEnding === "cr") return Promise.resolve();
    if (this.attaching) return this.attaching;
    const operation = this.performAttach(bridge);
    this.attaching = operation;
    void operation.finally(() => { this.attaching = null; this.releaseIfUnused(); }).catch(() => undefined);
    return operation;
  }
  private async performAttach(bridge: DesktopIdeBridge): Promise<void> {
    const wasPaused = this.paused;
    this.pause();
    let unsubscribe: (() => void) | null = null;
    let latest: DesktopIdeDocumentState | undefined;
    try {
      if (this.writing) await this.writing;
      const format = this.state.format;
      if (!format || this.state.saveError || this.state.conflict) return;
      const seed = this.state.value;
      const generation = this.editGeneration;
      unsubscribe = bridge.onEvent((event) => {
        if (event.kind !== "editor.state" || event.state.root !== this.cwd || event.state.path !== this.relativePath) return;
        if (!latest || event.state.revision > latest.revision) latest = event.state;
        if (this.native) this.receiveNative(event.state);
      });
      let result = requireCodeOssDocument(await bridge.request({ kind: "editor.open", document: this.document, initial: {
        value: seed, baseline: this.state.baseline, expectedVersion: format.expectedVersion, encoding: format.encoding,
      } }));
      // A native renderer is not yet mounted, but the legacy surface could have
      // accepted a final input event while the ownership request was in flight.
      if (generation !== this.editGeneration && this.state.value !== result.value) {
        if (result.value !== seed) throw new Error("The native buffer changed during handoff. The current unsaved Synara draft was retained; resolve the conflict before retrying.");
        result = requireCodeOssDocument(await bridge.request({ kind: "editor.edit", document: this.document, revision: result.revision, value: this.state.value }));
        if (this.state.value !== result.value) throw new Error("Editing continued during handoff. The unsaved Synara draft was retained; retry after finishing the current edit.");
      }
      this.native = bridge;
      this.nativeSubscription = unsubscribe;
      unsubscribe = null;
      this.receiveNative(latest && latest.revision > result.revision ? latest : result);
    } catch (error) {
      this.dispatch({ type: "saveFailed", message: error instanceof Error ? error.message : "The native editor could not take ownership of this buffer.", conflict: true });
      throw error;
    } finally {
      unsubscribe?.();
      this.paused = wasPaused;
      this.schedule();
    }
  }

  change = (value: string) => {
    this.editGeneration += 1;
    if (!this.native) {
      this.dispatch({ type: "changed", value });
      this.schedule();
      return;
    }
    const bridge = this.native;
    this.nativeQueue = this.nativeQueue.catch(() => undefined).then(async () => {
      const state = this.state.native;
      if (!state || state.value === value) return;
      this.receiveNative(requireCodeOssDocument(await bridge.request({ kind: "editor.edit", document: this.document, revision: state.revision, value })));
    }).catch((error) => {
      this.dispatch({ type: "saveFailed", message: error instanceof Error ? error.message : "The native edit could not be applied.", conflict: true });
    });
  };
  private clearTimer() { clearTimeout(this.timer); this.timer = undefined; }
  private schedule() {
    this.clearTimer();
    if (this.paused || this.writing || this.attaching || !this.dirty || this.state.saveError || this.state.conflict) return;
    this.timer = setTimeout(() => void this.flush(), WORKSPACE_EDITOR_AUTOSAVE_MS);
  }
  pause = () => { this.paused = true; this.clearTimer(); };
  resume = () => { this.paused = false; this.schedule(); };

  flush = (overwrite = false): Promise<boolean> => {
    this.clearTimer();
    if (this.writing) return this.writing;
    if (this.attaching) return this.attaching.then(() => this.flush(overwrite), () => false);
    if (this.paused) return Promise.resolve(!this.dirty);
    if (!this.dirty) return Promise.resolve(true);
    this.writing = Promise.resolve().then(async () => {
      if (this.native) {
        await this.nativeQueue;
        let force = overwrite;
        while (this.dirty) {
          const state = requireCodeOssDocument(await this.native.request({ kind: "editor.save", document: this.document, overwrite: force }));
          this.receiveNative(state);
          if (state.error || state.conflict) return false;
          force = false;
        }
        // Only refresh reads; never perform a second write through the server.
        void this.client.invalidateQueries({ queryKey: ["projects", "read-file", this.cwd] }).catch(() => undefined);
        void refreshGitAfterFileWrite(this.client, this.cwd).catch(() => undefined);
        return true;
      }
      let guarded = !overwrite;
      while (this.dirty) {
        const { value, format } = this.state;
        if (!format) return false;
        this.dispatch({ type: "saveStarted" });
        try {
          const result = await ensureNativeApi().projects.writeFile({
            cwd: this.cwd, relativePath: this.relativePath, contents: value,
            encoding: format.encoding, lineEnding: format.lineEnding,
            ...(guarded ? { expectedVersion: format.expectedVersion } : {}),
          });
          const queries = this.client.getQueryCache().findAll({
            queryKey: ["projects", "read-file", this.cwd],
            predicate: (query) => query.queryKey[3] === this.relativePath || (query.state.data as ProjectReadFileResult | undefined)?.relativePath === this.relativePath,
          });
          await Promise.all(queries.map((query) => this.client.cancelQueries({ queryKey: query.queryKey, exact: true })));
          for (const query of queries) this.client.setQueryData<ProjectReadFileResult>(query.queryKey, (previous) => previous ? { ...previous, contents: value, version: result.version } : previous);
          this.dispatch({ type: "saveSucceeded", contents: value, expectedVersion: result.version });
          void refreshGitAfterFileWrite(this.client, this.cwd).catch(() => undefined);
          guarded = true;
        } catch (error) {
          this.dispatch({ type: "saveFailed", message: error instanceof Error ? error.message : "Could not save the file.", conflict: isWorkspaceFileWriteConflictError(error) });
          return false;
        }
      }
      return true;
    }).catch((error) => {
      // A lost native response is not proof that a save did not occur. Keep
      // ownership and the buffer; do not retry using the legacy filesystem API.
      this.dispatch({ type: "saveFailed", message: error instanceof Error ? error.message : "The native file operation did not complete.", conflict: false });
      return false;
    }).finally(() => { this.writing = undefined; this.releaseIfUnused(); });
    return this.writing;
  };

  reload = async () => {
    this.pause();
    if (this.attaching) await this.attaching.catch(() => undefined);
    if (this.writing) await this.writing;
    const generation = this.editGeneration;
    try {
      if (this.native) {
        await this.nativeQueue;
        this.receiveNative(requireCodeOssDocument(await this.native.request({ kind: "editor.revert", document: this.document })));
        return;
      }
      const queryKey = projectQueryKeys.readFile(this.cwd, this.relativePath);
      await this.client.cancelQueries({ queryKey, exact: true });
      const file = await this.client.fetchQuery({ ...projectReadFileQueryOptions({ cwd: this.cwd, relativePath: this.relativePath }), staleTime: 0 });
      const format = resolveWorkspaceFileEditorFormat(file);
      if (generation === this.editGeneration && format) this.dispatch({ type: "reloaded", key: workspaceFileEditorKey(this.cwd, this.relativePath)!, contents: file.contents, format });
    } catch (error) {
      this.dispatch({ type: "saveFailed", message: error instanceof Error ? error.message : "Could not reload the file.", conflict: false });
    } finally { this.resume(); }
  };
  save = () => { this.paused = false; void this.flush(); };
  overwrite = () => { this.paused = false; void this.flush(true); };
}

export function getWorkspaceEditorSession(client: QueryClient, cwd: string, relativePath: string) {
  let entries = sessions.get(client);
  if (!entries) { entries = new Map(); sessions.set(client, entries); }
  const key = workspaceFileEditorKey(cwd, relativePath)!;
  let session = entries.get(key);
  if (!session) {
    const ownedEntries = entries;
    session = new WorkspaceEditorSession(client, cwd, relativePath, () => { if (ownedEntries.get(key) === session) ownedEntries.delete(key); });
    entries.set(key, session);
  }
  return session;
}
export function hasUnsavedWorkspaceEditors(client: QueryClient, cwd?: string | null) {
  return [...(sessions.get(client)?.values() ?? [])].some((session) => (cwd == null || session.cwd === cwd) && (session.dirty || session.saving));
}
export async function flushWorkspaceEditors(client: QueryClient, cwd?: string | null): Promise<boolean> {
  const pending = [...(sessions.get(client)?.values() ?? [])].filter((session) => (cwd == null || session.cwd === cwd) && (session.dirty || session.saving));
  const results = await Promise.all(pending.map((session) => session.getSnapshot().saveError || session.getSnapshot().conflict ? false : session.flush()));
  return results.every(Boolean);
}

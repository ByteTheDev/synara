import { Disposable, DisposableStore } from "../../base/common/lifecycle.js";
import { basename, join } from "../../base/common/path.js";
import { URI } from "../../base/common/uri.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { IFileService } from "../../platform/files/common/files.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { ITextFileService, TextFileEditorModelState, type IResolvedTextFileEditorModel } from "../../workbench/services/textfile/common/textfiles.js";
import { DESKTOP_IDE_MAX_BUFFER, type DesktopIdeBuffer, type DesktopIdeDocument, type DesktopIdeDocumentState, type DesktopIdeEvent, type DesktopIdeRequest } from "../common/desktopIde.js";

interface DocumentEntry {
  readonly document: DesktopIdeDocument;
  readonly resource: URI;
  readonly model: IResolvedTextFileEditorModel;
  readonly lifetime: DisposableStore;
  baseline: string;
  savedValue: string | undefined;
  revision: number;
  saving: boolean;
  error: string | null;
}
type DocumentRequest = Extract<DesktopIdeRequest, { document: DesktopIdeDocument }>;

/** One native text model per resource. Hiding the surface never closes a working copy. */
export class SynaraDocuments extends Disposable {
  private readonly entries = new Map<string, DocumentEntry>();
  private readonly opening = new Map<string, Promise<DocumentEntry>>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly diffModels = new Map<string, URI>();
  private nextDiff = 0;

  constructor(
    private readonly textFiles: ITextFileService,
    private readonly editors: IEditorService,
    private readonly files: IFileService,
    private readonly models: IModelService,
    private readonly textModels: ITextModelService,
    private readonly emit: (event: DesktopIdeEvent) => void,
  ) {
    super();
    this._register(this.textModels.registerTextModelContentProvider("synara-diff", {
      provideTextContent: async (resource) => this.models.getModel(resource),
    }));
    // Capture the text AFTER formatting/save participants, rather than assuming
    // the model still contains the saved version when an asynchronous write ends.
    this._register(this.textFiles.files.addSaveParticipant({
      ordinal: Number.MAX_SAFE_INTEGER,
      participate: async (model) => {
        const entry = this.entries.get(model.resource.toString());
        if (entry && model.isResolved()) {
          entry.savedValue = model.textEditorModel.getValue();
          this.publish(entry);
        }
      },
    }));
    this._register(this.editors.onDidActiveEditorChange(() => {
      const resource = this.editors.activeEditor?.resource;
      const entry = resource ? this.entries.get(resource.toString()) : undefined;
      if (entry) this.emit({ kind: "editor.reveal", document: entry.document });
    }));
  }

  async handle(request: DocumentRequest): Promise<DesktopIdeDocumentState> {
    const key = this.resource(request.document).toString();
    const previous = this.tails.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.perform(request));
    this.tails.set(key, operation);
    void operation.finally(() => {
      if (this.tails.get(key) === operation) this.tails.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  private resource(document: DesktopIdeDocument): URI {
    return URI.file(join(document.root, document.path));
  }
  private async open(document: DesktopIdeDocument, initial?: DesktopIdeBuffer): Promise<DocumentEntry> {
    const resource = this.resource(document);
    const key = resource.toString();
    const current = this.entries.get(key);
    if (current) return current;
    const pending = this.opening.get(key);
    if (pending) return pending;
    const operation = this.resolve(document, resource, initial);
    this.opening.set(key, operation);
    try { return await operation; } finally { this.opening.delete(key); }
  }

  private async resolve(document: DesktopIdeDocument, resource: URI, initial?: DesktopIdeBuffer): Promise<DocumentEntry> {
    const incomingDirty = initial !== undefined && initial.value !== initial.baseline;
    if (incomingDirty) {
      const raw = await this.files.readFile(resource, { limits: { size: DESKTOP_IDE_MAX_BUFFER * 4 } });
      const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(raw.value.buffer));
      const version = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      if (version !== initial.expectedVersion) {
        throw new Error("The file changed on disk before the editor handoff. Your unsaved Synara buffer is retained; resolve its existing save conflict before retrying.");
      }
    }
    const model = await this.textFiles.files.resolve(resource);
    if (!model.isResolved()) throw new Error("Code-OSS could not resolve this text file.");
    if (model.textEditorModel.getValueLength() > DESKTOP_IDE_MAX_BUFFER) throw new Error("This file is too large for the embedded editor bridge.");
    if (incomingDirty && model.isDirty() && model.textEditorModel.getValue() !== initial.value) {
      // A recovered native draft and a live Synara draft are two different pieces
      // of user work. Never pick a winner by overwriting either one.
      throw new Error("A different recovered Code-OSS draft exists for this file. Both drafts are retained. Save the current Synara draft before reopening the recovered draft.");
    }
    let baseline: string;
    try { baseline = (await this.textFiles.read(resource)).value; }
    catch (error) {
      if (!model.isDirty()) throw error;
      baseline = initial?.baseline ?? "";
    }
    const lifetime = new DisposableStore();
    try {
      // Pin the model independently of a particular React component/view lease.
      lifetime.add(await this.textModels.createModelReference(resource));
      const entry: DocumentEntry = { document, resource, model, lifetime, baseline, savedValue: undefined, revision: 0, saving: false, error: null };
      this.entries.set(resource.toString(), entry);
      lifetime.add(model.textEditorModel.onDidChangeContent(() => this.publish(entry)));
      lifetime.add(model.onDidChangeDirty(() => this.publish(entry)));
      lifetime.add(model.onDidSave(() => {
        if (entry.savedValue !== undefined) entry.baseline = entry.savedValue;
        else if (!model.isDirty()) entry.baseline = model.textEditorModel.getValue();
        entry.savedValue = undefined;
        entry.error = null;
        this.publish(entry);
        this.emit({ kind: "git.changed", root: document.root });
      }));
      lifetime.add(model.onDidSaveError(() => {
        entry.savedValue = undefined;
        entry.error = model.hasState(TextFileEditorModelState.CONFLICT)
          ? "The file changed on disk. Reload it or explicitly overwrite it."
          : "Code-OSS could not save this file. The unsaved buffer is retained.";
        this.publish(entry);
      }));
      lifetime.add(this.textFiles.files.onDidResolve(({ model: resolved }) => {
        if (resolved === model && !model.isDirty()) {
          entry.baseline = model.textEditorModel.getValue();
          entry.error = null;
          this.publish(entry);
        }
      }));
      if (initial) {
        model.updatePreferredEncoding(initial.encoding === "utf8-bom" ? "utf8bom" : initial.encoding);
        if (incomingDirty && !model.isDirty()) {
          entry.baseline = initial.baseline;
          this.replace(entry, initial.value);
        }
      }
      this.publish(entry);
      return entry;
    } catch (error) {
      lifetime.dispose();
      this.entries.delete(resource.toString());
      throw error;
    }
  }

  private replace(entry: DocumentEntry, value: string): void {
    const model = entry.model.textEditorModel;
    if (model.getValue() === value) return;
    model.pushStackElement();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: value }], () => null);
    model.pushStackElement();
  }
  private snapshot(entry: DocumentEntry): DesktopIdeDocumentState {
    return {
      ...entry.document,
      revision: entry.revision,
      value: entry.model.textEditorModel.getValue(),
      baseline: entry.baseline,
      dirty: entry.model.isDirty(),
      saving: entry.saving || entry.model.hasState(TextFileEditorModelState.PENDING_SAVE),
      conflict: entry.model.hasState(TextFileEditorModelState.CONFLICT),
      error: entry.error,
      canUndo: entry.model.textEditorModel.canUndo(),
      canRedo: entry.model.textEditorModel.canRedo(),
    };
  }
  private publish(entry: DocumentEntry): void {
    entry.revision += 1;
    this.emit({ kind: "editor.state", state: this.snapshot(entry) });
  }
  private async perform(request: DocumentRequest): Promise<DesktopIdeDocumentState> {
    const entry = await this.open(request.document, request.kind === "editor.open" ? request.initial : undefined);
    switch (request.kind) {
      case "editor.open": break;
      case "editor.show":
        await this.editors.openEditor({ resource: entry.resource, options: {
          pinned: true,
          ...(request.line === undefined ? {} : { selection: { startLineNumber: request.line, startColumn: request.column ?? 1 } }),
        } });
        break;
      case "editor.edit":
        if (entry.revision !== request.revision) throw new Error("The buffer changed before this edit arrived. Its newer contents were retained.");
        this.replace(entry, request.value);
        break;
      case "editor.undo": await entry.model.textEditorModel.undo(); break;
      case "editor.redo": await entry.model.textEditorModel.redo(); break;
      case "editor.save":
        entry.saving = true;
        entry.error = null;
        this.publish(entry);
        try {
          const saved = await entry.model.save({ ignoreErrorHandler: true, ignoreModifiedSince: request.overwrite === true });
          if (!saved && entry.model.isDirty()) entry.error = "The file was not saved. Its unsaved buffer is retained.";
        } catch (error) {
          entry.error = error instanceof Error ? error.message.slice(0, 8192) : "Could not save the file.";
        } finally { entry.saving = false; this.publish(entry); }
        break;
      case "editor.revert":
        await entry.model.revert({ force: true });
        entry.baseline = entry.model.textEditorModel.getValue();
        entry.error = null;
        this.publish(entry);
        break;
      case "editor.diff": {
        const key = `${entry.resource.toString()}\n${request.title}`;
        let original = this.diffModels.get(key);
        if (!original) {
          original = URI.from({ scheme: "synara-diff", path: `/${++this.nextDiff}/${basename(request.document.path)}` });
          this.diffModels.set(key, original);
          this.models.createModel(request.original, null, original);
        } else this.models.getModel(original)?.setValue(request.original);
        await this.editors.openEditor({ original: { resource: original }, modified: { resource: entry.resource }, label: request.title, options: { pinned: true } });
        break;
      }
      case "editor.release":
        // Retain working-copy identity, undo, diagnostics, breakpoints and backups.
        break;
    }
    return this.snapshot(entry);
  }
  override dispose(): void {
    for (const entry of this.entries.values()) entry.lifetime.dispose();
    for (const uri of this.diffModels.values()) this.models.getModel(uri)?.dispose();
    this.entries.clear();
    this.diffModels.clear();
    super.dispose();
  }
}

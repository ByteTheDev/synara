/* Code-OSS owns models and IDE services. Synara owns the surrounding editor UI. */
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { ipcRenderer } from "../../base/parts/sandbox/electron-browser/globals.js";
import { isCodeEditor, isDiffEditor } from "../../editor/browser/editorBrowser.js";
import { ILanguageService } from "../../editor/common/languages/language.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { ICommandService } from "../../platform/commands/common/commands.js";
import { IConfigurationService, ConfigurationTarget } from "../../platform/configuration/common/configuration.js";
import { IDialogService } from "../../platform/dialogs/common/dialogs.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { EditorResourceAccessor, SideBySideEditor } from "../../workbench/common/editor.js";
import { IViewDescriptorService, ViewContainerLocation } from "../../workbench/common/views.js";
import { ITerminalService } from "../../workbench/contrib/terminal/browser/terminal.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { IWorkbenchLayoutService, Parts } from "../../workbench/services/layout/browser/layoutService.js";
import { ITextFileService, TextFileEditorModelState } from "../../workbench/services/textfile/common/textfiles.js";
import { IViewsService } from "../../workbench/services/views/common/viewsService.js";
import { IWorkingCopyService } from "../../workbench/services/workingCopy/common/workingCopyService.js";
import {
  isDesktopEditorRequest,
  type DesktopIdeState,
  type DesktopEditorRequest,
  type DesktopEditorResult,
  type DesktopEditorState,
} from "../common/desktopIde.js";

const CHANNEL = "vscode:synara";
const EDITOR_CHANNEL = "vscode:synara:editor";
const navigationContainers = new Map([
  ["workbench.view.explorer", "files"],
  ["workbench.view.scm", "changes"],
  ["workbench.view.search", "search"],
]);

export class SynaraEmbeddedEditor extends Disposable {
  private readonly revisions = new Map<string, { contents: string; file: URI }>();
  private revisionSequence = 0;
  private queue = Promise.resolve();
  private saving = false;
  private frame: number | undefined;

  constructor(
    private readonly readState: () => DesktopIdeState | undefined,
    private readonly readyScope: () => Promise<void>,
    @IEditorService private readonly editors: IEditorService,
    @IEditorGroupsService private readonly groups: IEditorGroupsService,
    @ITextFileService private readonly textFiles: ITextFileService,
    @IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
    @ICommandService private readonly commands: ICommandService,
    @ITerminalService private readonly terminals: ITerminalService,
    @IViewsService private readonly views: IViewsService,
    @IWorkbenchLayoutService private readonly layout: IWorkbenchLayoutService,
    @IDialogService private readonly dialogs: IDialogService,
    @INotificationService private readonly notifications: INotificationService,
    @IConfigurationService configuration: IConfigurationService,
    @IViewDescriptorService descriptors: IViewDescriptorService,
    @ITextModelService resolver: ITextModelService,
    @IModelService models: IModelService,
    @ILanguageService languages: ILanguageService,
  ) {
    super();
    this._register(groups.enforcePartOptions({ showTabs: "none", showBreadcrumbs: false, editorActionsLocation: "hidden" }));
    // Window-local overrides, never user/workspace preference writes.
    for (const [key, value] of Object.entries({
      "window.customTitleBarVisibility": "never",
      "window.menuBarVisibility": "hidden",
      "workbench.statusBar.visible": false,
      "workbench.activityBar.location": "hidden",
      "workbench.editor.enablePreview": false,
    })) {
      void configuration.updateValue(key, value, ConfigurationTarget.MEMORY).catch(error => notifications.error(String(error)));
    }
    const hideDuplicateChrome = () => {
      for (const part of [Parts.ACTIVITYBAR_PART, Parts.SIDEBAR_PART, Parts.AUXILIARYBAR_PART, Parts.BANNER_PART]) {
        if (layout.isVisible(part)) layout.setPartHidden(true, part);
      }
    };
    hideDuplicateChrome();
    this._register(layout.onDidChangePartVisibility(hideDuplicateChrome));
    // Debug, Extensions, and extension-contributed views live in the existing
    // editor's lower tool area; never a second Explorer/Changes/navigation rail.
    const embedViews = () => {
      for (const location of [ViewContainerLocation.Sidebar, ViewContainerLocation.AuxiliaryBar]) {
        for (const container of descriptors.getViewContainersByLocation(location)) {
          if (navigationContainers.has(container.id) || container.id.includes("chat") || container.id.includes("sessions")) continue;
          descriptors.moveViewContainerToLocation(container, ViewContainerLocation.Panel, undefined, "Synara embedded editor");
        }
      }
    };
    embedViews();
    this._register(descriptors.onDidChangeViewContainers(embedViews));
    this._register(views.onDidChangeViewContainerVisibility(event => {
      const target = navigationContainers.get(event.id);
      if (!event.visible || !target) return;
      hideDuplicateChrome();
      void this.send("navigate", target);
    }));
    this._register(resolver.registerTextModelContentProvider("synara-revision", {
      provideTextContent: async resource => {
        const existing = models.getModel(resource);
        if (existing) return existing;
        const revision = this.revisions.get(resource.toString());
        if (!revision) return null;
        const model = models.createModel(revision.contents, languages.createByFilepathOrFirstLine(revision.file), resource);
        model.onWillDispose(() => this.revisions.delete(resource.toString()));
        return model;
      },
    }));
    this._register(editors.onDidActiveEditorChange(() => this.report()));
    this._register(editors.onDidEditorsChange(() => this.report()));
    this._register(workingCopies.onDidChangeDirty(() => this.report()));
    this._register(workingCopies.onDidChangeContent(() => this.report()));
    this._register(textFiles.files.onDidSave(event => {
      this.report();
      void this.send("saved", event.model.resource.toString());
    }));
    this._register(textFiles.files.onDidSaveError(() => this.report()));
    const receive = (_event: unknown, message: unknown) => {
      if (!message || typeof message !== "object") return;
      const envelope = message as { id?: unknown; request?: unknown; resource?: unknown };
      if (!Number.isSafeInteger(envelope.id) || !isDesktopEditorRequest(envelope.request)) return;
      const request = envelope.request;
      this.queue = this.queue.then(async () => {
        try {
          await this.readyScope();
          const selected = this.readState();
          if (request.surfaceId !== selected?.surfaceId || request.generation !== selected?.generation)
            throw new Error("The selected Synara editor or session changed.");
          const result = await this.execute(request, envelope.resource);
          this.report();
          await this.send("editor-result", { id: envelope.id, result });
        } catch (error) {
          await this.send("editor-result", { id: envelope.id, error: String(error) });
        }
      }).catch(error => notifications.error(`Synara editor bridge: ${String(error)}`));
    };
    ipcRenderer.on(EDITOR_CHANNEL, receive);
    this._register(toDisposable(() => {
      ipcRenderer.removeListener(EDITOR_CHANNEL, receive);
      if (this.frame !== undefined) cancelAnimationFrame(this.frame);
      this.revisions.clear();
    }));
    this.report();
  }

  private send(kind: string, value?: unknown): Promise<unknown> {
    return ipcRenderer.invoke(CHANNEL, { kind, value });
  }
  private activeResource(): URI | undefined {
    return EditorResourceAccessor.getOriginalUri(this.editors.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
  }
  private report(): void {
    if (this.frame !== undefined) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      const input = this.editors.activeEditor;
      const resource = this.activeResource();
      const control = this.editors.activeTextEditorControl;
      const model = isDiffEditor(control) ? control.getModifiedEditor().getModel() : isCodeEditor(control) ? control.getModel() : null;
      const file = resource ? this.textFiles.files.get(resource) : undefined;
      const state: DesktopEditorState = {
        resource: resource?.toString() ?? null,
        name: input?.getName() ?? "",
        dirty: input?.isDirty() ?? false,
        saving: this.saving || (file?.hasState(TextFileEditorModelState.PENDING_SAVE) ?? false),
        canUndo: model?.canUndo() ?? false,
        canRedo: model?.canRedo() ?? false,
        dirtyResources: this.workingCopies.dirtyWorkingCopies.map(copy => copy.resource.toString()).slice(0, 10000),
      };
      void this.send("editor-state", state).catch(error => this.notifications.error(String(error)));
    });
  }
  private async execute(request: DesktopEditorRequest, rawResource: unknown): Promise<DesktopEditorResult> {
    if (request.kind === "open") {
      if (typeof rawResource !== "string") throw new Error("Missing validated editor resource.");
      const resource = URI.parse(rawResource);
      if (resource.scheme !== "file") throw new Error("The shell editor requires a local file.");
      if (request.original) {
        const original = URI.from({ scheme: "synara-revision", path: resource.path, query: String(++this.revisionSequence) });
        this.revisions.set(original.toString(), { contents: request.original.contents, file: resource });
        try {
          await this.editors.openEditor({ original: { resource: original }, modified: { resource }, label: request.original.label, options: { pinned: true, preserveFocus: false } });
        } catch (error) {
          this.revisions.delete(original.toString());
          throw error;
        }
      } else {
        // Opening an existing native model never writes the disk snapshot over it.
        await this.editors.openEditor({ resource, options: { pinned: true, preserveFocus: false } });
      }
      return { resource: resource.toString() };
    }
    const resource = this.activeResource();
    if (request.resource !== (resource?.toString() ?? null))
      throw new Error("The active file changed. Try the action again.");
    const input = this.editors.activeEditor;
    const group = this.groups.activeGroup;
    switch (request.kind) {
      case "save":
        if (!input) throw new Error("No active editor to save.");
        this.saving = true;
        this.report();
        try {
          const result = await this.editors.save({ editor: input, groupId: group.id });
          if (!result.success) throw new Error("The file was not saved. Resolve the native save confirmation or conflict.");
        } finally {
          this.saving = false;
          this.report();
        }
        return {};
      case "close":
        // Upstream handles Save / Don't Save / Cancel and extension vetoes.
        return { closed: input ? await group.closeEditor(input) : true };
      case "revert":
        if (!input) return {};
        if ((await this.dialogs.confirm({ type: "warning", message: "Discard unsaved changes?", detail: "This reloads the active native editor from disk.", primaryButton: "Discard changes" })).confirmed)
          await this.editors.revert({ editor: input, groupId: group.id });
        return {};
      case "undo":
      case "redo":
        this.editors.activeEditorPane?.focus();
        await this.commands.executeCommand(request.kind);
        return {};
      case "format":
        this.editors.activeEditorPane?.focus();
        await this.commands.executeCommand("editor.action.formatDocument");
        return {};
      case "toggle-diff":
        await this.commands.executeCommand("toggle.diff.renderSideBySide");
        return {};
      case "terminal":
        if (this.views.isViewContainerVisible("workbench.panel.terminal")) {
          this.layout.setPartHidden(true, Parts.PANEL_PART);
          this.editors.activeEditorPane?.focus();
          return {};
        }
        if (this.terminals.activeInstance) {
          await this.terminals.revealActiveTerminal();
          await this.terminals.activeInstance.focusWhenReady();
          return {};
        }
        // First opening creates a native pty in the selected worktree.
        return this.createTerminal();
      case "new-terminal":
        return this.createTerminal();
      case "debug":
        await this.views.openViewContainer("workbench.view.debug", true);
        return {};
      case "extensions":
        await this.views.openViewContainer("workbench.view.extensions", true);
        return {};
      case "problems":
        await this.commands.executeCommand("workbench.actions.view.problems");
        return {};
      case "commands":
        await this.commands.executeCommand("workbench.action.showCommands");
        return {};
    }
  }
  private async createTerminal(): Promise<DesktopEditorResult> {
    const root = this.readState()?.scope.roots[0];
    if (!root) throw new Error("Select a local project or worktree before opening a terminal.");
    const terminal = await this.terminals.createTerminal({ config: { cwd: URI.file(root), name: "Synara worktree" } });
    this.terminals.setActiveInstance(terminal);
    await this.terminals.revealActiveTerminal();
    await terminal.focusWhenReady();
    return {};
  }
}

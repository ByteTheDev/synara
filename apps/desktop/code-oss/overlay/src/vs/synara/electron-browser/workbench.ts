/* Code-OSS services inside the existing Synara editor, not another IDE surface. */
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { ipcRenderer } from "../../base/parts/sandbox/electron-browser/globals.js";
import { ICodeEditorService } from "../../editor/browser/services/codeEditorService.js";
import { IModelService } from "../../editor/common/services/model.js";
import { ITextModelService } from "../../editor/common/services/resolverService.js";
import { ICommandService } from "../../platform/commands/common/commands.js";
import { IExtensionManagementService } from "../../platform/extensionManagement/common/extensionManagement.js";
import { IFileService } from "../../platform/files/common/files.js";
import { IMarkerService, MarkerSeverity } from "../../platform/markers/common/markers.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { IQuickInputService } from "../../platform/quickinput/common/quickInput.js";
import { IWorkspaceContextService } from "../../platform/workspace/common/workspace.js";
import { registerWorkbenchContribution2, WorkbenchPhase } from "../../workbench/common/contributions.js";
import { IDebugService, State, type IExpressionContainer } from "../../workbench/contrib/debug/common/debug.js";
import { ITerminalService } from "../../workbench/contrib/terminal/browser/terminal.js";
import { IEditorGroupsService } from "../../workbench/services/editor/common/editorGroupsService.js";
import { IEditorService } from "../../workbench/services/editor/common/editorService.js";
import { IWorkbenchLayoutService, Parts, EditorTabsMode } from "../../workbench/services/layout/browser/layoutService.js";
import { ITextFileService } from "../../workbench/services/textfile/common/textfiles.js";
import { IWorkbenchThemeService } from "../../workbench/services/themes/common/workbenchThemeService.js";
import { IWorkspaceEditingService } from "../../workbench/services/workspaces/common/workspaceEditing.js";
import { DESKTOP_IDE_PROTOCOL, DESKTOP_IDE_MAX_CONTEXT, isDesktopIdeRequest,
  type DesktopIdeCommand, type DesktopIdeContext, type DesktopIdeEvent,
  type DesktopIdeReply, type DesktopIdeRequest, type DesktopIdeState,
} from "../common/desktopIde.js";
import { SynaraWorkbenchAppearance } from "./appearance.js";
import { SynaraDocuments } from "./documents.js";
import { SynaraTerminals } from "./terminals.js";

const CHANNEL = "vscode:synara";
const COMMANDS: Partial<Record<DesktopIdeCommand, string>> = {
  suggest: "editor.action.triggerSuggest",
  definition: "editor.action.revealDefinition",
  references: "editor.action.referenceSearch.trigger",
  rename: "editor.action.rename",
  format: "editor.action.formatDocument",
  commands: "workbench.action.showCommands",
  debugStart: "workbench.action.debug.start",
  debugStop: "workbench.action.debug.stop",
  debugContinue: "workbench.action.debug.continue",
  debugPause: "workbench.action.debug.pause",
  debugStepOver: "workbench.action.debug.stepOver",
  debugStepInto: "workbench.action.debug.stepInto",
  debugStepOut: "workbench.action.debug.stepOut",
  debugRestart: "workbench.action.debug.restart",
  debugConfigure: "workbench.action.debug.configure",
  breakpoint: "editor.debug.action.toggleBreakpoint",
};

function request(kind: string, value?: unknown): Promise<unknown> {
  return ipcRenderer.invoke(CHANNEL, { kind, value });
}

class SynaraWorkbench extends Disposable {
  static readonly ID = "synara.workbench";
  private state: DesktopIdeState | undefined;
  private workspaceQueue = Promise.resolve();
  private generation = -1;
  private readonly documents: SynaraDocuments;
  private readonly terminals: SynaraTerminals;

  constructor(
    @ICommandService private readonly commands: ICommandService,
    @ICodeEditorService private readonly codeEditors: ICodeEditorService,
    @IEditorService private readonly editors: IEditorService,
    @ITextFileService textFiles: ITextFileService,
    @IFileService files: IFileService,
    @IModelService models: IModelService,
    @ITextModelService textModels: ITextModelService,
    @ITerminalService terminals: ITerminalService,
    @IDebugService private readonly debug: IDebugService,
    @IMarkerService private readonly markers: IMarkerService,
    @IQuickInputService private readonly quickInput: IQuickInputService,
    @INotificationService private readonly notifications: INotificationService,
    @IExtensionManagementService private readonly extensions: IExtensionManagementService,
    @IWorkbenchThemeService themes: IWorkbenchThemeService,
    @IWorkspaceContextService workspace: IWorkspaceContextService,
    @IWorkspaceEditingService editing: IWorkspaceEditingService,
    @IWorkbenchLayoutService layout: IWorkbenchLayoutService,
    @IEditorGroupsService groups: IEditorGroupsService,
  ) {
    super();
    const emit = (event: DesktopIdeEvent) => {
      void request("event", event).catch((error) => console.error("Synara native event delivery failed", error));
    };
    this.documents = this._register(new SynaraDocuments(textFiles, editors, files, models, textModels, emit));
    this.terminals = this._register(new SynaraTerminals(terminals, emit));
    const appearance = this._register(new SynaraWorkbenchAppearance(themes));
    this._register(groups.enforcePartOptions({ showTabs: EditorTabsMode.NONE }));
    // Only the native editor area is rendered. Synara owns Files, Changes,
    // navigation, tabs, chat and terminal presentation. Services remain loaded.
    const hidden = new Set<Parts>([
      Parts.TITLEBAR_PART, Parts.BANNER_PART, Parts.ACTIVITYBAR_PART,
      Parts.SIDEBAR_PART, Parts.AUXILIARYBAR_PART, Parts.STATUSBAR_PART,
      Parts.PANEL_PART, Parts.SESSIONS_PART, Parts.CUSTOM_VIEW_GRID_PART,
    ]);
    const hideChrome = () => {
      for (const part of hidden) layout.setPartHidden(true, part);
      layout.setPartHidden(false, Parts.EDITOR_PART);
    };
    hideChrome();
    this._register(layout.onDidChangePartVisibility(({ partId, visible }) => {
      if (visible && hidden.has(partId as Parts)) layout.setPartHidden(true, partId as Parts);
    }));
    const publishDebug = () => emit({ kind: "debug.state", state:
      debug.state === State.Stopped ? "stopped" : debug.state === State.Running ? "running" :
        debug.state === State.Initializing ? "initializing" : "inactive" });
    this._register(debug.onDidChangeState(publishDebug));
    const update = (state: DesktopIdeState) => {
      if (state.protocol !== DESKTOP_IDE_PROTOCOL) return;
      this.state = state;
      if (state.appearance) void appearance.apply(state.appearance).catch((error) => notifications.error(error));
      if (state.generation === this.generation) return;
      this.generation = state.generation;
      this.workspaceQueue = this.workspaceQueue.catch(() => undefined).then(async () => {
        const existing = new Set(workspace.getWorkspace().folders.map((folder) => folder.uri.toString()));
        const additions = state.scope.roots.map((root) => URI.file(root)).filter((uri) => !existing.has(uri.toString()));
        if (additions.length) await editing.addFolders(additions.map((uri) => ({ uri })));
        this.documents.setRoots(workspace.getWorkspace().folders.map((folder) => folder.uri.fsPath));
      });
      void this.workspaceQueue.catch((error) => notifications.error(error));
    };
    const listener = (_event: unknown, state: DesktopIdeState) => update(state);
    ipcRenderer.on(CHANNEL, listener);
    this._register(toDisposable(() => ipcRenderer.removeListener(CHANNEL, listener)));
    const operation = (_event: unknown, packet: { id?: unknown; request?: unknown }) => {
      if (!packet || !Number.isSafeInteger(packet.id) || !isDesktopIdeRequest(packet.request)) return;
      const id = Number(packet.id);
      const command = packet.request;
      void this.workspaceQueue.then(() => this.handle(command)).then(
        (result) => request("reply", { id, result }),
        (error) => request("reply", { id, error: (error instanceof Error ? error.message : String(error)).slice(0, 8192) }),
      ).catch((error) => console.error("Synara native request reply failed", error));
    };
    ipcRenderer.on(`${CHANNEL}:request`, operation);
    this._register(toDisposable(() => ipcRenderer.removeListener(`${CHANNEL}:request`, operation)));
    void request("ready", DESKTOP_IDE_PROTOCOL).then((state) => { update(state as DesktopIdeState); publishDebug(); }, (error) => notifications.error(error));
  }

  private async handle(operation: DesktopIdeRequest): Promise<DesktopIdeReply> {
    if ("document" in operation) return this.documents.handle(operation);
    if (operation.kind.startsWith("terminal.")) {
      return this.terminals.handle(operation as Extract<DesktopIdeRequest, { id: string; kind: `terminal.${string}` }>);
    }
    switch (operation.kind) {
      case "editor.command": await this.command(operation.command); return null;
      case "git.stage": case "git.unstage":
        await this.commands.executeCommand("synara.native.git", {
          operation: operation.kind === "git.stage" ? "stage" : "unstage", root: operation.root, paths: operation.paths,
        });
        await request("event", { kind: "git.changed", root: operation.root });
        return null;
      case "extensions.list": {
        const installed = await this.extensions.getInstalled();
        return installed.map((extension) => ({ id: extension.identifier.id, name: extension.manifest.displayName ?? extension.manifest.name, version: extension.manifest.version, builtin: extension.isBuiltin }));
      }
      case "extensions.install":
        await this.commands.executeCommand("workbench.extensions.installExtension", operation.id);
        return null;
      case "extensions.uninstall": {
        const installed = await this.extensions.getInstalled();
        const extension = installed.find((item) => item.identifier.id.toLowerCase() === operation.id.toLowerCase());
        if (!extension || extension.isBuiltin) throw new Error("Only an installed, non-built-in extension can be uninstalled.");
        await this.extensions.uninstall(extension);
        return null;
      }
      default: throw new Error("Unsupported Synara native operation.");
    }
  }

  private async command(command: DesktopIdeCommand): Promise<void> {
    const action = COMMANDS[command];
    if (action) { await this.commands.executeCommand(action); return; }
    switch (command) {
      case "sendSelection": {
        const editor = this.codeEditors.getFocusedCodeEditor() ?? this.codeEditors.getActiveCodeEditor();
        const model = editor?.getModel();
        const selections = editor?.getSelections();
        if (!model || !selections?.length || selections.every((selection) => selection.isEmpty())) throw new Error("Select code before adding it to the agent draft.");
        await this.context("selection", model.uri.toString(), selections.map((selection) => `Lines ${selection.startLineNumber}-${selection.endLineNumber}\n${model.getValueInRange(selection)}`).join("\n\n"));
        return;
      }
      case "sendDiagnostics": {
        const resource = this.editors.activeEditor?.resource;
        if (!resource) return;
        await this.context("diagnostics", resource.toString(), this.markers.read({ resource, take: 100 }).map((marker) => `${marker.startLineNumber}:${marker.startColumn} ${MarkerSeverity.toString(marker.severity)} ${marker.message}`).join("\n"));
        return;
      }
      case "problems": {
        const markers = this.markers.read({ take: 500 });
        const selected = await this.quickInput.pick(markers.map((marker) => ({ label: marker.message, description: `${marker.resource.fsPath}:${marker.startLineNumber}`, marker })), { placeHolder: "Workspace problems" });
        if (selected) await this.editors.openEditor({ resource: selected.marker.resource, options: { pinned: true, selection: { startLineNumber: selected.marker.startLineNumber, startColumn: selected.marker.startColumn } } });
        return;
      }
      case "extensions": await this.manageExtensions(); return;
      case "debugConsole": await this.inspectDebugger(); return;
      default: throw new Error("This editor command is not supported.");
    }
  }
  private async context(kind: DesktopIdeContext["kind"], title: string, text: string): Promise<void> {
    const state = this.state;
    if (!state?.scope.threadId) throw new Error("Select a Synara session before adding context.");
    if (!text.trim()) throw new Error("There is no context to add.");
    await request("context", { threadId: state.scope.threadId, generation: state.generation, kind, title: title.slice(0, 512), text: text.slice(0, DESKTOP_IDE_MAX_CONTEXT) });
  }
  private async manageExtensions(): Promise<void> {
    const installed = await this.extensions.getInstalled();
    const selected = await this.quickInput.pick([
      { label: "Install extension…", description: "Open VSX · publisher.extension", id: "", builtin: false },
      ...installed.map((extension) => ({ label: extension.manifest.displayName ?? extension.manifest.name, description: `${extension.identifier.id} · ${extension.manifest.version}${extension.isBuiltin ? " · built-in" : ""}`, id: extension.identifier.id, builtin: extension.isBuiltin })),
    ], { placeHolder: "Extensions for the existing Synara editor" });
    if (!selected) return;
    if (!selected.id) {
      const id = await this.quickInput.input({ prompt: "Open VSX extension identifier (publisher.extension)", validateInput: async (value) => /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/iu.test(value) ? undefined : "Enter publisher.extension." });
      if (id) await this.handle({ kind: "extensions.install", id });
    } else if (!selected.builtin) {
      const action = await this.quickInput.pick([{ label: "Uninstall", id: "uninstall" }, { label: "Cancel", id: "cancel" }], { placeHolder: selected.id });
      if (action?.id === "uninstall") await this.handle({ kind: "extensions.uninstall", id: selected.id });
    }
  }
  private async inspectDebugger(): Promise<void> {
    const session = this.debug.getViewModel().focusedSession;
    const frame = this.debug.getViewModel().focusedStackFrame;
    if (!session) throw new Error("Start a debugging session first.");
    const action = await this.quickInput.pick([
      { label: "Debug console output", id: "output" },
      { label: "Evaluate expression", id: "evaluate" },
      { label: "Variables in current frame", id: "variables" },
      { label: "Choose stack frame", id: "stack" },
    ], { placeHolder: session.name });
    if (action?.id === "evaluate") {
      const expression = await this.quickInput.input({ prompt: "Evaluate in the current debug frame" });
      if (expression) await session.addReplExpression(frame, expression);
    }
    if (action?.id === "output" || action?.id === "evaluate") {
      await this.quickInput.pick(session.getReplElements().slice(-200).map((element) => ({ label: element.toString() || " " })), { placeHolder: "Debug console" });
    } else if (action?.id === "variables" && frame) {
      const scopes = await frame.getScopes();
      const scope = await this.quickInput.pick(scopes.map((scope) => ({ label: scope.name, scope })), { placeHolder: "Variables" });
      if (scope) await this.inspectVariables(scope.scope);
    } else if (action?.id === "stack") {
      const frames = session.getAllThreads().flatMap((thread) => thread.getCallStack());
      const chosen = await this.quickInput.pick(frames.map((frame) => ({ label: frame.name, description: `${frame.source.name}:${frame.range.startLineNumber}`, frame })), { placeHolder: "Call stack" });
      if (chosen) await this.debug.focusStackFrame(chosen.frame);
    }
  }
  private async inspectVariables(container: IExpressionContainer): Promise<void> {
    const children = await container.getChildren();
    const selected = await this.quickInput.pick(children.map((child) => ({ label: child.name, description: child.value, child })), { placeHolder: "Variables · select to expand" });
    if (selected?.child.hasChildren) await this.inspectVariables(selected.child);
  }
}

registerWorkbenchContribution2(SynaraWorkbench.ID, SynaraWorkbench, WorkbenchPhase.AfterRestored);

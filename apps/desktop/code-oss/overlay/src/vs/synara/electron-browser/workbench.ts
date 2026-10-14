/* Native IDE services are embedded in Synara's existing editor, never a new mode. */
import { SynaraWorkbenchAppearance } from "./appearance.js";
import { SynaraEmbeddedEditor } from "./editor.js";
import { IWorkbenchThemeService } from "../../workbench/services/themes/common/workbenchThemeService.js";
import { Codicon } from "../../base/common/codicons.js";
import { Disposable, toDisposable } from "../../base/common/lifecycle.js";
import { URI } from "../../base/common/uri.js";
import { ipcRenderer } from "../../base/parts/sandbox/electron-browser/globals.js";
import { ICodeEditorService } from "../../editor/browser/services/codeEditorService.js";
import { localize2 } from "../../nls.js";
import { Action2, MenuId, registerAction2 } from "../../platform/actions/common/actions.js";
import { IInstantiationService, ServicesAccessor } from "../../platform/instantiation/common/instantiation.js";
import { IMarkerService, MarkerSeverity } from "../../platform/markers/common/markers.js";
import { INotificationService } from "../../platform/notification/common/notification.js";
import { IWorkspaceContextService } from "../../platform/workspace/common/workspace.js";
import { registerWorkbenchContribution2, WorkbenchPhase } from "../../workbench/common/contributions.js";
import { IDebugService } from "../../workbench/contrib/debug/common/debug.js";
import { ITerminalService } from "../../workbench/contrib/terminal/browser/terminal.js";
import { IWorkspaceEditingService } from "../../workbench/services/workspaces/common/workspaceEditing.js";
import { DESKTOP_IDE_PROTOCOL, DESKTOP_IDE_MAX_CONTEXT, type DesktopIdeState, type DesktopIdeContext } from "../common/desktopIde.js";

const CHANNEL = "vscode:synara";
let state: DesktopIdeState | undefined;
function request(kind: string, value?: unknown): Promise<unknown> {
  return ipcRenderer.invoke(CHANNEL, { kind, value });
}

async function sendContext(
  kind: DesktopIdeContext["kind"],
  title: string,
  text: string,
): Promise<void> {
  const selected = state;
  if (!selected?.scope.threadId)
    throw new Error("Select a Synara agent session before sending context.");
  if (!text.trim()) throw new Error("There is no selected context to send.");
  const suffix = "\n[Context truncated by Synara.]";
  const context: DesktopIdeContext = {
    threadId: selected.scope.threadId,
    generation: selected.generation,
    kind,
    title: title.slice(0, 512),
    text:
      text.length > DESKTOP_IDE_MAX_CONTEXT
        ? text.slice(0, DESKTOP_IDE_MAX_CONTEXT - suffix.length) + suffix
        : text,
  };
  await request("context", context);
}
registerAction2(
  class extends Action2 {
    constructor() {
      super({
        id: "synara.sendSelection",
        title: localize2("synara.selection", "Synara: Add Selected Code to Agent Draft"),
        f1: true,
        menu: [{ id: MenuId.EditorContext, group: "synara", order: 1 }],
      });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
      const editor =
        accessor.get(ICodeEditorService).getFocusedCodeEditor() ??
        accessor.get(ICodeEditorService).getActiveCodeEditor();
      const model = editor?.getModel();
      const selections = editor?.getSelections();
      if (!model || !selections?.length) return;
      const text = selections
        .map(
          (selection) =>
            `Lines ${selection.startLineNumber}-${selection.endLineNumber}\n${model.getValueInRange(selection)}`,
        )
        .join("\n\n");
      if (selections.every((selection) => selection.isEmpty()))
        throw new Error("Select code before adding it to the agent draft.");
      await sendContext("selection", model.uri.toString(), text);
    }
  },
);
registerAction2(
  class extends Action2 {
    constructor() {
      super({
        id: "synara.sendDiagnostics",
        title: localize2("synara.diagnostics", "Synara: Add Current File Problems to Agent Draft"),
        f1: true,
      });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
      const model = accessor.get(ICodeEditorService).getActiveCodeEditor()?.getModel();
      if (!model) return;
      const markers = accessor.get(IMarkerService).read({ resource: model.uri, take: 100 });
      await sendContext(
        "diagnostics",
        model.uri.toString(),
        markers
          .map(
            (marker) =>
              `${marker.startLineNumber}:${marker.startColumn} ${MarkerSeverity.toString(marker.severity)} ${marker.message}`,
          )
          .join("\n"),
      );
    }
  },
);
registerAction2(
  class extends Action2 {
    constructor() {
      super({
        id: "synara.sendTerminalSelection",
        title: localize2("synara.terminal", "Synara: Add Terminal Selection to Agent Draft"),
        f1: true,
        menu: [{ id: MenuId.TerminalInstanceContext, group: "synara", order: 1 }],
      });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
      const terminal = accessor.get(ITerminalService).activeInstance;
      await sendContext("terminal", terminal?.title ?? "Terminal", terminal?.selection ?? "");
    }
  },
);
registerAction2(
  class extends Action2 {
    constructor() {
      super({
        id: "synara.sendDebugContext",
        title: localize2("synara.debug", "Synara: Add Debug Stack to Agent Draft"),
        f1: true,
      });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
      const viewModel = accessor.get(IDebugService).getViewModel();
      const frame = viewModel.focusedStackFrame;
      const frames = viewModel.focusedThread?.getCallStack() ?? [];
      await sendContext(
        "debug",
        viewModel.focusedSession?.name ?? "Debug session",
        frames
          .map(
            (item) =>
              `${item === frame ? "> " : "  "}${item.name} ${item.source.uri.toString()}:${item.range.startLineNumber}`,
          )
          .join("\n"),
      );
    }
  },
);

registerAction2(
  class extends Action2 {
    constructor() {
      super({
        id: "synara.newWorktreeTerminal",
        title: localize2("synara.worktreeTerminal", "Synara: New Terminal in Active Worktree"),
        f1: true,
        icon: Codicon.terminal,
      });
    }
    async run(accessor: ServicesAccessor): Promise<void> {
      const root = state?.scope.roots[0];
      if (!root) throw new Error("Select a Synara session with a local project or worktree first.");
      const terminals = accessor.get(ITerminalService);
      const terminal = await terminals.createTerminal({
        config: { cwd: URI.file(root), name: "Synara worktree" },
      });
      terminals.setActiveInstance(terminal);
      await terminals.revealActiveTerminal();
      await terminal.focusWhenReady();
    }
  },
);
registerAction2(
  class extends Action2 {
    constructor() {
      super({
        id: "synara.revealWorktree",
        title: localize2("synara.revealWorktree", "Synara: Reveal Active Worktree in Explorer"),
        f1: true,
      });
    }
    async run(): Promise<void> {
      const root = state?.scope.roots[0];
      if (!root) throw new Error("Select a Synara session with a local project or worktree first.");
      await request("navigate", "files");
    }
  },
);

registerAction2(
  class extends Action2 {
    constructor() {
      super({
        id: "synara.nextAttention",
        title: localize2("synara.attention", "Synara: Next Agent Needing Attention"),
        f1: true,
        icon: Codicon.bell,
      });
    }
    async run(): Promise<void> {
          await request("attention");
    }
  },
);

class SynaraWorkbench extends Disposable {
  static readonly ID = "synara.workbench";
  private workspaceQueue = Promise.resolve();
  private generation = -1;
  constructor(
    @IWorkspaceContextService workspace: IWorkspaceContextService,
    @IWorkspaceEditingService editing: IWorkspaceEditingService,
    @INotificationService notifications: INotificationService,
    @IWorkbenchThemeService themes: IWorkbenchThemeService,
    @IInstantiationService instantiation: IInstantiationService,
  ) {
    super();
    const appearance = this._register(new SynaraWorkbenchAppearance(themes));
    this._register(instantiation.createInstance(SynaraEmbeddedEditor, () => state, () => this.workspaceQueue));
    const update = (next: DesktopIdeState) => {
      if (next.appearance)
        void appearance.apply(next.appearance).catch(error => notifications.error(`Synara appearance: ${String(error)}`));
      state = next;
      if (next.generation === this.generation) return;
      this.workspaceQueue = this.workspaceQueue.then(async () => {
        if (state?.generation !== next.generation || next.generation === this.generation) return;
        const folders = next.scope.roots.map(root => ({ uri: URI.file(root) }))
          .filter(folder => !workspace.getWorkspaceFolder(folder.uri));
        // Additive handoff: no folder reload, dirty-buffer discard, terminal or
        // debugger restart, implicit Git checkout, or second agent connection.
        if (folders.length) await editing.addFolders(folders, true);
        this.generation = next.generation;
      }).catch(error => notifications.error(`Synara could not add the selected workspace: ${String(error)}`));
    };
    const receive = (_event: unknown, next: unknown) => {
      if (next && typeof next === "object" && (next as DesktopIdeState).protocol === DESKTOP_IDE_PROTOCOL)
        update(next as DesktopIdeState);
    };
    ipcRenderer.on(CHANNEL, receive);
    this._register(toDisposable(() => ipcRenderer.removeListener(CHANNEL, receive)));
    void request("ready").then(next => receive(undefined, next))
      .catch(error => notifications.error(`Synara desktop bridge unavailable: ${String(error)}`));
  }
}
registerWorkbenchContribution2(SynaraWorkbench.ID, SynaraWorkbench, WorkbenchPhase.AfterRestored);

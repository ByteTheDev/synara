/* Native Code-OSS contribution. The pane hosts the existing Synara renderer via
 * an Electron sibling view, not a webview/iframe or a second agent extension. */
import { Codicon } from '../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../base/common/keyCodes.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { ipcRenderer } from '../../base/parts/sandbox/electron-browser/globals.js';
import { ICommandService } from '../../platform/commands/common/commands.js';
import { ICodeEditorService } from '../../editor/browser/services/codeEditorService.js';
import { localize2 } from '../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../platform/dialogs/common/dialogs.js';
import { SyncDescriptor } from '../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../platform/keybinding/common/keybindingsRegistry.js';
import { IMarkerService, MarkerSeverity } from '../../platform/markers/common/markers.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../platform/workspace/common/workspace.js';
import { ViewPane } from '../../workbench/browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../workbench/browser/parts/views/viewPaneContainer.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../workbench/common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../workbench/common/views.js';
import { IDebugService } from '../../workbench/contrib/debug/common/debug.js';
import { ITerminalService } from '../../workbench/contrib/terminal/browser/terminal.js';
import { IStatusbarService, StatusbarAlignment } from '../../workbench/services/statusbar/browser/statusbar.js';
import { IViewsService } from '../../workbench/services/views/common/viewsService.js';
import { IWorkspaceEditingService } from '../../workbench/services/workspaces/common/workspaceEditing.js';
import { DESKTOP_IDE_MAX_CONTEXT, type DesktopIdeState, type DesktopIdeContext } from '../common/desktopIde.js';

const CHANNEL = 'vscode:synara';
const VIEW_ID = 'synara.agents';
let state: DesktopIdeState | undefined;
let activePane: SynaraAgentPane | undefined;
function request(kind: string, value?: unknown): Promise<unknown> { return ipcRenderer.invoke(CHANNEL, { kind, value }); }
let revealAgents: (() => Promise<void>) | undefined;
function sendPane(visible: boolean, rect: DOMRect): void {
	void request('pane', { visible, x: Math.max(0, rect.x), y: Math.max(0, rect.y), width: rect.width, height: rect.height });
}

class SynaraAgentPane extends ViewPane {
	private body: HTMLElement | undefined;
	private frame: number | undefined;
	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.body = container;
		activePane = this;
		container.setAttribute('aria-label', 'Synara agents');
		const observer = new ResizeObserver(() => this.reportBounds());
		observer.observe(container);
		this._register(toDisposable(() => {
			observer.disconnect();
			if (this.frame !== undefined) cancelAnimationFrame(this.frame);
			if (activePane === this) activePane = undefined;
			sendPane(false, container.getBoundingClientRect());
		}));
		this._register(this.onDidChangeBodyVisibility(() => this.reportBounds()));
		this._register(this.viewDescriptorService.onDidChangeLocation(() => this.reportBounds()));
		this.reportBounds();
	}
	override focus(): void { super.focus(); void request('focus-agent'); }
	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.reportBounds();
	}
	reportBounds(): void {
		if (this.frame !== undefined) cancelAnimationFrame(this.frame);
		this.frame = requestAnimationFrame(() => {
			this.frame = undefined;
			if (this.body) sendPane(this.isBodyVisible(), this.body.getBoundingClientRect());
		});
	}
}
const container = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: 'synara', title: localize2('synara.container', 'Synara Agents'), icon: Codicon.commentDiscussion,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, ['synara', { mergeViewWithContainerWhenSingleView: true }]),
	storageId: 'synara', hideIfEmpty: false, order: 0
}, ViewContainerLocation.AuxiliaryBar);
Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: VIEW_ID, name: localize2('synara.agents', 'Synara Agents'), containerIcon: Codicon.commentDiscussion,
	ctorDescriptor: new SyncDescriptor(SynaraAgentPane), canToggleVisibility: true, canMoveView: true,
	focusCommand: { id: 'synara.focusAgents' }
}], container);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'synara.toggleMode', title: localize2('synara.toggle', 'Synara: Switch Agent / IDE Mode'), f1: true,
			icon: Codicon.layout, keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyG, weight: KeybindingWeight.WorkbenchContrib },
			menu: [{ id: MenuId.TitleBar, group: 'navigation', order: -100 }, { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VIEW_ID), group: 'navigation' }] });
	}
	async run(): Promise<void> { await request('mode', state?.mode === 'agent' ? 'ide' : 'agent'); }
});

async function sendContext(kind: DesktopIdeContext['kind'], title: string, text: string): Promise<void> {
	const selected = state;
	if (!selected?.scope.threadId) throw new Error('Select a Synara agent session before sending context.');
	if (!text.trim()) throw new Error('There is no selected context to send.');
	const suffix = '\n[Context truncated by Synara.]';
	const context: DesktopIdeContext = {
		threadId: selected.scope.threadId, generation: selected.generation, kind, title: title.slice(0, 512),
		text: text.length > DESKTOP_IDE_MAX_CONTEXT ? text.slice(0, DESKTOP_IDE_MAX_CONTEXT - suffix.length) + suffix : text
	};
	await revealAgents?.();
	await request('context', context);
}
registerAction2(class extends Action2 {
	constructor() { super({ id: 'synara.sendSelection', title: localize2('synara.selection', 'Synara: Add Selected Code to Agent Draft'), f1: true,
		menu: [{ id: MenuId.EditorContext, group: 'synara', order: 1 }] }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor() ?? accessor.get(ICodeEditorService).getActiveCodeEditor();
		const model = editor?.getModel();
		const selections = editor?.getSelections();
		if (!model || !selections?.length) return;
		const text = selections.map(selection => `Lines ${selection.startLineNumber}-${selection.endLineNumber}\n${model.getValueInRange(selection)}`).join('\n\n');
		if (selections.every(selection => selection.isEmpty())) throw new Error('Select code before adding it to the agent draft.');
		await sendContext('selection', model.uri.toString(), text);
	}
});
registerAction2(class extends Action2 {
	constructor() { super({ id: 'synara.sendDiagnostics', title: localize2('synara.diagnostics', 'Synara: Add Current File Problems to Agent Draft'), f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		const model = accessor.get(ICodeEditorService).getActiveCodeEditor()?.getModel();
		if (!model) return;
		const markers = accessor.get(IMarkerService).read({ resource: model.uri, take: 100 });
		await sendContext('diagnostics', model.uri.toString(), markers.map(marker => `${marker.startLineNumber}:${marker.startColumn} ${MarkerSeverity.toString(marker.severity)} ${marker.message}`).join('\n'));
	}
});
registerAction2(class extends Action2 {
	constructor() { super({ id: 'synara.sendTerminalSelection', title: localize2('synara.terminal', 'Synara: Add Terminal Selection to Agent Draft'), f1: true,
		menu: [{ id: MenuId.TerminalInstanceContext, group: 'synara', order: 1 }] }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		const terminal = accessor.get(ITerminalService).activeInstance;
		await sendContext('terminal', terminal?.title ?? 'Terminal', terminal?.selection ?? '');
	}
});
registerAction2(class extends Action2 {
	constructor() { super({ id: 'synara.sendDebugContext', title: localize2('synara.debug', 'Synara: Add Debug Stack to Agent Draft'), f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		const viewModel = accessor.get(IDebugService).getViewModel();
		const frame = viewModel.focusedStackFrame;
		const frames = viewModel.focusedThread?.getCallStack() ?? [];
		await sendContext('debug', viewModel.focusedSession?.name ?? 'Debug session',
			frames.map(item => `${item === frame ? '> ' : '  '}${item.name} ${item.source.uri.toString()}:${item.range.startLineNumber}`).join('\n'));
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'synara.newWorktreeTerminal', title: localize2('synara.worktreeTerminal', 'Synara: New Terminal in Active Worktree'), f1: true, icon: Codicon.terminal,
		menu: [{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VIEW_ID), group: 'navigation', order: 2 }] }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		const root = state?.scope.roots[0];
		if (!root) throw new Error('Select a Synara session with a local project or worktree first.');
		const terminals = accessor.get(ITerminalService);
		const terminal = await terminals.createTerminal({ config: { cwd: URI.file(root), name: 'Synara worktree' } });
		terminals.setActiveInstance(terminal);
		await terminals.revealActiveTerminal();
	}
});
registerAction2(class extends Action2 {
	constructor() { super({ id: 'synara.revealWorktree', title: localize2('synara.revealWorktree', 'Synara: Reveal Active Worktree in Explorer'), f1: true }); }
	async run(accessor: ServicesAccessor): Promise<void> {
		const root = state?.scope.roots[0];
		if (!root) throw new Error('Select a Synara session with a local project or worktree first.');
		await accessor.get(ICommandService).executeCommand('revealInExplorer', URI.file(root));
	}
});

registerAction2(class extends Action2 {
	constructor() { super({ id: 'synara.nextAttention', title: localize2('synara.attention', 'Synara: Next Agent Needing Attention'), f1: true, icon: Codicon.bell }); }
	async run(): Promise<void> { await revealAgents?.(); await request('attention'); }
});

class SynaraWorkbench extends Disposable {
	static readonly ID = 'synara.workbench';
	private workspaceQueue = Promise.resolve();
	private generation = -1;
	private hasEnteredIde = false;
	constructor(
		@IViewsService views: IViewsService,
		@IStatusbarService statusbar: IStatusbarService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IWorkspaceEditingService editing: IWorkspaceEditingService,
		@IKeybindingService keybindings: IKeybindingService,
		@INotificationService notifications: INotificationService,
		@IQuickInputService quickInput: IQuickInputService,
		@IDialogService dialogs: IDialogService,
	) {
		super();
		revealAgents = async () => { await views.openView(VIEW_ID, true); activePane?.reportBounds(); };
		const attention = this._register(statusbar.addEntry({ name: 'Synara agent attention', text: '$(bell) 0', ariaLabel: 'Agents needing attention', command: 'synara.nextAttention' }, 'synara.attention', StatusbarAlignment.LEFT, 9999));
		const entry = this._register(statusbar.addEntry({ name: 'Synara', text: 'Agent / IDE', ariaLabel: 'Switch Synara Agent and IDE modes', command: 'synara.toggleMode' }, 'synara.mode', StatusbarAlignment.LEFT, 10000));
		const updateShortcut = () => { void request('shortcut', keybindings.lookupKeybinding('synara.toggleMode')?.getElectronAccelerator() ?? null); };
		this._register(keybindings.onDidUpdateKeybindings(updateShortcut));
		let quickInputOpen = false;
		let dialogOpen = false;
		const occlusion = () => { void request('overlay', quickInputOpen || dialogOpen); };
		this._register(quickInput.onShow(() => { quickInputOpen = true; occlusion(); }));
		this._register(quickInput.onHide(() => { quickInputOpen = false; occlusion(); }));
		this._register(dialogs.onWillShowDialog(() => { dialogOpen = true; occlusion(); }));
		this._register(dialogs.onDidShowDialog(() => { dialogOpen = false; occlusion(); }));
		const update = (next: DesktopIdeState) => {
			attention.update({ name: 'Synara agent attention', text: `$(bell) ${next.attention}`, ariaLabel: `${next.attention} agents need attention`, command: 'synara.nextAttention', tooltip: 'Open the next Synara agent needing attention' });
			const previousMode = state?.mode;
			state = next;
			entry.update({ name: 'Synara', text: `${next.mode === 'agent' ? '$(hubot) Agent' : '$(code) IDE'}${next.attention ? ` · ${next.attention} need attention` : ''}`, ariaLabel: 'Switch Synara Agent and IDE modes', command: 'synara.toggleMode', tooltip: 'Synara: Agent / IDE — sessions and editors stay running' });
			if (next.mode !== 'ide') return;
			if (previousMode !== 'ide') {
				if (!this.hasEnteredIde) {
					this.hasEnteredIde = true;
					void views.openView(VIEW_ID, false).then(() => activePane?.reportBounds());
				} else { activePane?.reportBounds(); }
			}
			if (next.generation === this.generation) return;
			this.workspaceQueue = this.workspaceQueue.then(async () => {
				if (state?.generation !== next.generation || next.generation === this.generation) return;
				const folders = next.scope.roots.map(root => ({ uri: URI.file(root) })).filter(folder => !workspace.getWorkspaceFolder(folder.uri));
				// Additive multi-root handoff: no folder reload, dirty-buffer discard,
				// terminal restart, debugger restart or implicit Git checkout.
				if (folders.length) await editing.addFolders(folders, true);
				this.generation = next.generation;
			}).catch(error => notifications.error(`Synara could not add the selected workspace: ${String(error)}`));
		};
		const receive = (_event: unknown, next: unknown) => {
			if (next && typeof next === 'object' && (next as DesktopIdeState).protocol === 1) update(next as DesktopIdeState);
		};
		ipcRenderer.on(CHANNEL, receive);
		this._register(toDisposable(() => ipcRenderer.removeListener(CHANNEL, receive)));
		void request('ready').then(next => { receive(undefined, next); updateShortcut(); }).catch(error => notifications.error(`Synara desktop bridge unavailable: ${String(error)}`));
	}
}
registerWorkbenchContribution2(SynaraWorkbench.ID, SynaraWorkbench, WorkbenchPhase.AfterRestored);

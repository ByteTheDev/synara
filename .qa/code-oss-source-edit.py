"""Apply only the authorized existing-editor integration. No dependencies or tests."""
from pathlib import Path
import json
import re
import subprocess
import urllib.request

BASE = 'a62d7c733d19f5538ffc0d126d57437b3b578ff1'
EXPECTED = 'b7ca4735fc4a27c5c121e50f9f96e45dc39ebbef'
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
if head != EXPECTED:
    raise SystemExit(f'Refusing to edit a changed feature head: {head}')


def change(path, before, after):
    file = Path(path)
    text = file.read_text()
    count = text.count(before)
    if count != 1:
        raise RuntimeError(f'{path}: expected one source anchor, found {count}: {before[:120]!r}')
    file.write_text(text.replace(before, after, 1))


def prepend(path, text):
    file = Path(path)
    file.write_text(text + file.read_text())


# Shared contracts: no frontend exposure of the private PTY transport.
p = 'packages/contracts/src/desktopIde.ts'
change(p, 'export interface DesktopIdeBridge {', '''export interface DesktopIdeShortcut {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly modKey: boolean;
}
export function isDesktopIdeShortcut(value: unknown): value is DesktopIdeShortcut {
  return record(value) && text(value.key, 64) &&
    [value.metaKey, value.ctrlKey, value.altKey, value.shiftKey, value.modKey].every((item) => typeof item === "boolean");
}
export interface DesktopIdeBridge {''')
change(p, '  setScope(scope: DesktopIdeScope): Promise<void>;', '  setScope(scope: DesktopIdeScope): Promise<void>;\n  setSaveShortcut(shortcut: DesktopIdeShortcut | null): Promise<void>;')
change(p, 'readonly kind: "editor.command"; readonly command: DesktopIdeCommand', 'readonly kind: "editor.command"; readonly command: DesktopIdeCommand; readonly document?: DesktopIdeDocument')
change(p, 'readonly original: string; readonly title: string', 'readonly original: string; readonly title: string; readonly renderSideBySide?: boolean')
change(p, 'export type DesktopIdeEvent =\n', 'export type DesktopIdeEvent =\n  | { readonly kind: "editor.saveRequested" }\n')
change(p, 'case "editor.command": return DESKTOP_IDE_COMMANDS.some((command) => command === value.command);', 'case "editor.command": return DESKTOP_IDE_COMMANDS.some((command) => command === value.command) && (value.document === undefined || isDesktopIdeDocument(value.document));')
change(p, 'typeof value.original === "string" && value.original.length <= DESKTOP_IDE_MAX_BUFFER && text(value.title, 1024);', 'typeof value.original === "string" && value.original.length <= DESKTOP_IDE_MAX_BUFFER && text(value.title, 1024) && (value.renderSideBySide === undefined || typeof value.renderSideBySide === "boolean");')

p = 'packages/contracts/src/desktopPty.ts'
change(p, '  readonly env: Readonly<Record<string, string>>;', '  readonly env: Readonly<Record<string, string>>;\n  readonly onlyExisting?: boolean;\n  readonly afterSequence?: number;')
change(p, '  | { readonly kind: "pause" | "resume" | "dispose"; readonly id: string }', '  | { readonly kind: "pause" | "resume"; readonly id: string; readonly reason?: "consumer" | "transport" }\n  | { readonly kind: "dispose"; readonly id: string }')
change(p, '  readonly pid: number;', '  readonly pid: number | null;')
change(p, '  readonly history: string;', '  readonly history: string;\n  readonly historyTruncated: boolean;')
change(p, 'if (!isDesktopPtyOwner(value.owner) ||', 'if ((value.onlyExisting !== undefined && typeof value.onlyExisting !== "boolean") || (value.afterSequence !== undefined && !size(value.afterSequence, 0, Number.MAX_SAFE_INTEGER)) || !isDesktopPtyOwner(value.owner) ||')
change(p, 'case "pause": case "resume": case "dispose": return true;', 'case "pause": case "resume": return value.reason === undefined || value.reason === "consumer" || value.reason === "transport";\n    case "dispose": return true;')
change(p, 'size(value.pid, 1, 0x7fffffff)', '(value.pid === null || size(value.pid, 1, 0x7fffffff))')
change(p, 'typeof value.history === "string" && value.history.length <= DESKTOP_PTY_MAX_FRAME / 4 &&', 'typeof value.history === "string" && value.history.length <= DESKTOP_PTY_MAX_FRAME / 4 && typeof value.historyTruncated === "boolean" &&')
index = Path('packages/contracts/src/index.ts')
index.write_text(index.read_text() + '\nexport * from "./desktopPty";\n')

# Restore the user's original app layout, navigation and styling, not the old PR modes.
for path in ['apps/web/src/components/AppShellTopStrip.tsx', 'apps/web/src/routes/_chat.tsx', 'apps/web/src/index.css']:
    contents = subprocess.check_output(['git', 'show', f'{BASE}:{path}'])
    Path(path).write_bytes(contents)

# Register visible editor roots separately from focused chats. The host retains
# old native working copies while only the current selection is published.
p = 'apps/web/src/desktopIdeStore.ts'
change(p, '  debugState: "inactive"', '  editorRoots: readonly string[];\n  debugState: "inactive"')
change(p, '  debugState: "inactive",', '  editorRoots: [],\n  debugState: "inactive",')
file = Path(p)
file.write_text(file.read_text() + '''
const editorRoots = new Map<string, number>();
export function registerDesktopEditorRoot(root: string): () => void {
  editorRoots.set(root, (editorRoots.get(root) ?? 0) + 1);
  useDesktopIdeStore.setState({ editorRoots: [...editorRoots.keys()] });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = editorRoots.get(root) ?? 0;
    if (count <= 1) editorRoots.delete(root); else editorRoots.set(root, count - 1);
    useDesktopIdeStore.setState({ editorRoots: [...editorRoots.keys()] });
  };
}
''')
p = 'apps/web/src/hooks/useWorkspaceFileEditor.ts'
change(p, 'import { useDesktopIdeStore }', 'import { registerDesktopEditorRoot, useDesktopIdeStore }')
change(p, '  const availability = useDesktopIdeStore', '  useEffect(() => enabled && cwd ? registerDesktopEditorRoot(cwd) : undefined, [enabled, cwd]);\n  const availability = useDesktopIdeStore')

# The exact same controller feeds the pre-existing file/diff surfaces.
for filename, component in [('WorkspaceFileEditorPane.tsx', 'CodeEditorPane'), ('WorkspaceFileDiffEditorPane.tsx', 'CodeDiffEditorPane')]:
    p = 'apps/web/src/components/chat/' + filename
    prepend(p, 'import { CodeOssEditorActions } from "../codeEditor/CodeOssEditorActions";\n')
    change(p, f'<{component}\n', f'<{component}\n          nativeState={{session.nativeState}}\n')
    file = Path(p)
    text = file.read_text()
    if filename == 'WorkspaceFileEditorPane.tsx':
        start = text.index('          <WorkspaceFileEditorHistoryActions')
        end = text.index('          />', start) + len('          />')
        history = text[start:end]
        text = text[:start] + '          <>\n' + history + '\n            {session.nativeState ? <CodeOssEditorActions document={session.nativeState} /> : null}\n          </>' + text[end:]
    else:
        anchor = '        actions={\n          <>'
        if text.count(anchor) != 1: raise RuntimeError('Unexpected editable diff header')
        text = text.replace(anchor, anchor + '\n            {session.nativeState ? <CodeOssEditorActions document={session.nativeState} /> : null}', 1)
    file.write_text(text)

# The inline preview has its own old renderer: preserve that browser renderer,
# but use the same native model when the canonical session has handed it off.
p = 'apps/web/src/components/WorkspaceFilePreview.tsx'
prepend(p, 'import { NativeCodeEditorPane } from "./codeEditor/NativeCodeEditorPane";\nimport type { DesktopIdeDocumentState } from "@synara/contracts";\n')
file = Path(p)
text = file.read_text()
match = re.search(r'(?:interface EditableFileContentsProps\s*\{|type EditableFileContentsProps\s*=\s*\{)', text)
if not match: raise RuntimeError('Editable preview props anchor missing')
text = text[:match.end()] + '\n  nativeState?: DesktopIdeDocumentState | undefined;' + text[match.end():]
text = text.replace('  return plainText ? (', '''  if (props.nativeState) return (
    <div className={cn("min-h-0 min-w-0 flex-1 flex-col", props.hidden ? "hidden" : "flex")} hidden={props.hidden}>
      <NativeCodeEditorPane nativeState={props.nativeState} fileName={props.path} onSave={props.onSave} />
    </div>
  );
  return plainText ? (''', 1)
text = text.replace('            <EditableFileContents\n', '            <EditableFileContents\n              nativeState={editor.nativeState}\n', 1)
text = text.replace('  const editBufferExternallyChanged =\n    editBufferDirty &&', '  const editBufferExternallyChanged =\n    !editor.nativeState &&\n    editBufferDirty &&', 1)
file.write_text(text)

# Cross-renderer preload is a bounded service bridge, never a process capability.
p = 'apps/desktop/src/ipcChannels.ts'
file = Path(p)
text = file.read_text()
start = text.index('  ide: {')
end = text.index('  },', start) + len('  },')
text = text[:start] + '''  ide: {
    state: "desktop:ide:state",
    scope: "desktop:ide:scope",
    appearance: "desktop:ide:appearance",
    context: "desktop:ide:context",
    prepareQuit: "desktop:ide:prepare-quit",
    surface: "desktop:ide:surface",
    releaseSurface: "desktop:ide:release-surface",
    request: "desktop:ide:request",
    event: "desktop:ide:event",
    saveShortcut: "desktop:ide:save-shortcut",
  },''' + text[end:]
file.write_text(text)
p = 'apps/desktop/src/preload.ts'
file = Path(p)
text = file.read_text()
start = text.index('  ide: {')
end = text.index('  ...(betaDiagnosticsBridge', start)
text = text[:start] + '''  ide: {
    getState: () => ipcRenderer.invoke(IPC.ide.state),
    setScope: (scope) => ipcRenderer.invoke(IPC.ide.scope, scope),
    setAppearance: (appearance) => ipcRenderer.invoke(IPC.ide.appearance, appearance),
    setSaveShortcut: (shortcut) => ipcRenderer.invoke(IPC.ide.saveShortcut, shortcut),
    setSurface: (surface) => ipcRenderer.invoke(IPC.ide.surface, surface),
    releaseSurface: (lease) => ipcRenderer.invoke(IPC.ide.releaseSurface, lease),
    request: (request) => ipcRenderer.invoke(IPC.ide.request, request),
    prepareQuit: (requestId) => ipcRenderer.invoke(IPC.ide.prepareQuit, requestId),
    onState: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
      ipcRenderer.on(IPC.ide.state, receive);
      return () => ipcRenderer.removeListener(IPC.ide.state, receive);
    },
    onEvent: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, event: Parameters<typeof listener>[0]) => listener(event);
      ipcRenderer.on(IPC.ide.event, receive);
      return () => ipcRenderer.removeListener(IPC.ide.event, receive);
    },
    onContext: (listener) => {
      const receive = (_event: Electron.IpcRendererEvent, context: Parameters<typeof listener>[0]) => listener(context);
      ipcRenderer.on(IPC.ide.context, receive);
      return () => ipcRenderer.removeListener(IPC.ide.context, receive);
    },
  },
''' + text[end:]
file.write_text(text)

# Native custom keybinding and the immutable instance-local view factory.
p = 'apps/desktop/src/codeOssHost.ts'
prepend(p, 'import { keybindingShortcutToAccelerator, matchesDesktopAccelerator } from "./menuShortcuts";\nimport { isDesktopIdeShortcut, type DesktopIdeShortcut } from "@synara/contracts";\n')
change(p, '  private nextRequest = 0;', '  private nextRequest = 0;\n  private scopeSequence = 0;\n  private saveShortcut: DesktopIdeShortcut | null = null;')
change(p, '    handle(IPC.scope, async (value) => {', '    handle(IPC.scope, async (value) => {\n      const sequence = ++this.scopeSequence;')
change(p, '      for (const [root, actual] of grants)', '      if (sequence !== this.scopeSequence) return;\n      for (const [root, actual] of grants)')
change(p, 'roots: [...new Set(grants.map(([root]) => root))]', 'roots: [...new Set(value.roots)]')
change(p, '    handle(IPC.appearance, (value) => {', '''    handle(IPC.saveShortcut, (value) => {
      if (value !== null && !isDesktopIdeShortcut(value)) throw new Error("Invalid save shortcut.");
      this.saveShortcut = value;
    });
    handle(IPC.appearance, (value) => {''')
change(p, '    this.nativeContents.add(embedded.editor.webContents.id);', '''    this.nativeContents.add(embedded.editor.webContents.id);
    embedded.editor.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isComposing) return;
      const accelerator = this.saveShortcut ? keybindingShortcutToAccelerator(this.saveShortcut, process.platform) : null;
      const configured = matchesDesktopAccelerator(accelerator, process.platform, input);
      const nativeDefault = matchesDesktopAccelerator("CommandOrControl+S", process.platform, input);
      if (!configured && !nativeDefault) return;
      event.preventDefault();
      if (configured) this.sendEvent({ kind: "editor.saveRequested" });
    });''')

p = 'apps/web/src/components/codeEditor/NativeCodeEditorPane.tsx'
change(p, '  const state = useRef(props.nativeState);\n  state.current = props.nativeState;\n', '')
change(p, '    let disposed = false;', '    let disposed = false;\n    let selected = false;')
change(p, '        setError(null);\n        const document', '        setError(null);\n        previous = "";\n        selected = false;\n        const document')
change(p, '        else await bridge.request({ kind: "editor.show", document });', '        else await bridge.request({ kind: "editor.show", document });\n        selected = true;')
change(p, '      if (disposed || activeSurface !== surface) return;', '      if (disposed || !selected || activeSurface !== surface) return;')
change(p, '    const resize = new ResizeObserver(schedule);', '''    const removeEvents = bridge.onEvent((event) => {
      if (event.kind === "editor.saveRequested" && activeSurface === surface) save.current();
    });
    const resize = new ResizeObserver(schedule);''')
change(p, '      resize.disconnect();', '      removeEvents();\n      resize.disconnect();')

p = 'apps/web/src/lib/workspaceEditorSession.ts'
change(p, 'this.attaching = null; this.releaseIfUnused();', 'this.attaching = null; this.schedule(); this.releaseIfUnused();')
change(p, '    if (!this.dirty) return Promise.resolve(true);', '    if (!this.dirty && !this.native) return Promise.resolve(true);')
change(p, '        let force = overwrite;\n        while (this.dirty) {', '        let force = overwrite;\n        let first = true;\n        while (first || this.dirty) {\n          first = false;')

# Native construction is patched at its source, not by moving an already attached WebContents.
p = 'apps/desktop/code-oss/patches.json'
file = Path(p)
patches = json.loads(file.read_text())
window_patch = next(item for item in patches if item['path'].endswith('/windows/electron-main/windowImpl.ts'))
upstream_url = 'https://raw.githubusercontent.com/microsoft/vscode/7baac39ec3ca969dab74ac12c097f6a486e46593/' + window_patch['path']
with urllib.request.urlopen(upstream_url, timeout=20) as response:
    upstream = response.read().decode()
anchor = 'this._win = new electron.BrowserWindow(options);'
if upstream.count(anchor) != 1: raise RuntimeError('Pinned CodeWindow constructor anchor changed')
window_patch['edits'].append({'before': anchor, 'after': 'this._win = synaraHost()?.createWindow(options) ?? new electron.BrowserWindow(options);'})
file.write_text(json.dumps(patches, indent=2) + '\n')
p = 'apps/desktop/code-oss/scripts/prepare.mjs'
change(p, 'protocol: 1,', 'protocol: 2,')
file = Path(p)
text = file.read_text()
# Reuse the existing canonical-contract copy statement with a second exact path.
match = re.search(r'await (?:cp|copyFile)\([\s\S]*?desktopIde\.ts[\s\S]*?\);', text)
if not match: raise RuntimeError('Canonical native contract copy statement missing')
statement = match.group(0)
# A non-greedy search must not duplicate preceding unrelated copy operations.
start = max(statement.rfind('await cp('), statement.rfind('await copyFile('))
statement = statement[start:]
if 'desktopIde.ts' not in statement: raise RuntimeError('Invalid canonical contract copy anchor')
text = text.replace(statement, statement + '\n' + statement.replace('desktopIde.ts', 'desktopPty.ts'), 1)
file.write_text(text)

# Remove the mode-only callback from main; the user's shell remains visible.
p = 'apps/desktop/src/main.ts'
file = Path(p)
text = file.read_text()
match = re.search(r'\n  onMode: \([^)]*\) => \{[\s\S]*?\n  \},', text)
if not match: raise RuntimeError('Old mode callback anchor missing')
text = text[:match.start()] + text[match.end():]
file.write_text(text)

# Reuse, rather than copy, private socket-directory ownership helpers.
p = 'apps/desktop/src/browserUsePipeServer.ts'
for name in ['ensureUnixPipeParent', 'cleanupUnixPipe']:
    change(p, f'function {name}(', f'export function {name}(')

# Source-edits are restricted to the requested implementation surface.
allowed = ('apps/desktop/', 'apps/web/', 'packages/contracts/', 'apps/server/', 'scripts/')
changed = subprocess.check_output(['git', 'diff', '--name-only'], text=True).splitlines()
if any(not path.startswith(allowed) for path in changed): raise RuntimeError('Unexpected modified path')
print('SOURCE EDITS APPLIED; no build, dependency installation, CI checks or tests were run.')
for path in changed: print(path)

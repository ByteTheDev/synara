// Branch-only assembly for the recovered candidate. Excluded from publication.
import { readFile, writeFile } from 'node:fs/promises';
async function edit(file, before, after) {
  const text = await readFile(file, 'utf8');
  if (text.split(before).length !== 2) throw new Error(`Expected exactly one anchor in ${file}: ${before}`);
  await writeFile(file, text.replace(before, after));
}
async function all(file, before, after) {
  const text = await readFile(file, 'utf8');
  if (!text.includes(before)) throw new Error(`Missing anchor in ${file}: ${before}`);
  await writeFile(file, text.replaceAll(before, after));
}
async function prepend(file, contents) {
  await writeFile(file, contents + await readFile(file, 'utf8'));
}
await import('./repair-extension-candidate.mjs');
await edit('scripts/build-code-oss-host.mjs', 'external: ["@vscode/spdlog",', 'external: ["@vscode/windows-ca-certs", "@vscode/spdlog",');
await all('apps/server/src/extensions/host/entry.mjs', 'host.extensionService', 'host._extensionService');
await edit('apps/server/src/extensions/host/entry.mjs', 'exists: (file) => lstat(file).then(() => true, () => false), realpath', 'fsExists: (file) => lstat(file).then(() => true, () => false), fsRealpath: realpath');
await prepend('apps/server/src/extensions/host/entry.mjs', 'import { createWriteStream } from "node:fs";\n');
await edit('apps/server/src/extensions/host/entry.mjs', 'const output = process.stdout.write.bind(process.stdout);', 'const protocolOutput = createWriteStream("", { fd: 3, autoClose: false });\nconst output = protocolOutput.write.bind(protocolOutput);');
await all('apps/server/src/platform/extensionHostSandbox.ts', 'stdio: ["pipe", "pipe", "pipe"]', 'stdio: ["pipe", "pipe", "pipe", "pipe"]');
await all('apps/server/src/extensions/realHost.test.ts', 'stdio: ["pipe", "pipe", "pipe"]', 'stdio: ["pipe", "pipe", "pipe", "pipe"]');
await prepend('packages/contracts/src/index.ts', 'export * from "./editorExtensionRuntime";\n');
await prepend('packages/contracts/src/ipc.ts', 'import type { EditorExtensionRuntimeInput, EditorExtensionRuntimeResult } from "./editorExtensionRuntime";\n');
await edit('packages/contracts/src/ipc.ts', '  editor?: {\n', '  editor?: {\n    extensionRuntime?: (input: EditorExtensionRuntimeInput, options?: { signal?: AbortSignal }) => Promise<EditorExtensionRuntimeResult>;\n');
await edit('packages/contracts/src/ws.ts', 'export const WS_METHODS = {\n', 'export const WS_METHODS = {\n  editorExtensionRuntime: "editor.extensionRuntime",\n');
await prepend('packages/contracts/src/rpc.ts', 'import { EditorExtensionRuntimeInput, EditorExtensionRuntimeResult } from "./editorExtensionRuntime";\n');
await edit('packages/contracts/src/rpc.ts', 'export const WsEditorExtensionsRpc =', 'export const WsEditorExtensionRuntimeRpc = Rpc.make(WS_METHODS.editorExtensionRuntime, {\n  payload: EditorExtensionRuntimeInput, success: EditorExtensionRuntimeResult, error: WsRpcError,\n});\n\nexport const WsEditorExtensionsRpc =');
await edit('packages/contracts/src/rpc.ts', '  WsEditorExtensionsRpc,\n', '  WsEditorExtensionsRpc,\n  WsEditorExtensionRuntimeRpc,\n');
await edit('apps/server/src/wsRpc.ts', 'import { ExtensionManager } from "./extensions/extensionManager";', 'import { ExtensionRuntime } from "./extensions/extensionRuntime";');
await edit('apps/server/src/wsRpc.ts', 'new ExtensionManager(config.stateDir)', 'new ExtensionRuntime(config.stateDir)');
await edit('apps/server/src/wsRpc.ts', '        [WS_METHODS.editorExtensions]:', '        [WS_METHODS.editorExtensionRuntime]: (input, { clientId }) =>\n          requireWsOwnerSession.pipe(Effect.andThen(() => rpcEffect(Effect.tryPromise({\n            try: (signal) => editorExtensions.runtimeRequest(String(clientId), input, signal),\n            catch: (cause) => cause instanceof Error ? cause : new Error("Extension runtime operation failed."),\n          }), "Extension runtime operation failed"))),\n        [WS_METHODS.editorExtensions]:');
await edit('apps/web/src/wsNativeApi.ts', '    editor: {\n', '    editor: {\n      extensionRuntime: (input, options) => transport.request(WS_METHODS.editorExtensionRuntime, input, {\n        ...(options?.signal ? { signal: options.signal } : {}),\n      }),\n');
await edit('apps/server/src/extensions/extensionRuntime.ts', 'fileURLToPath, pathToFileURL', 'fileURLToPath');
await edit('apps/server/src/extensions/extensionRuntime.ts', '  private disposed = false;', '  private disposed = false;\n  private generation = 0;\n  private readonly starts = new Map<string, Promise<RuntimeSlot>>();');
await edit('apps/server/src/extensions/extensionRuntime.ts', '  private async start(owner: string, cwdInput: string, documents: readonly EditorDocument[]): Promise<RuntimeSlot> {', '  private start(owner: string, cwd: string, documents: readonly EditorDocument[]): Promise<RuntimeSlot> {\n    const key = JSON.stringify([owner, cwd]);\n    const existing = this.starts.get(key);\n    if (existing) return existing;\n    const pending = this.startOnce(owner, cwd, documents).finally(() => this.starts.delete(key));\n    this.starts.set(key, pending);\n    return pending;\n  }\n  private async startOnce(owner: string, cwdInput: string, documents: readonly EditorDocument[]): Promise<RuntimeSlot> {\n    const generation = this.generation;');
await edit('apps/server/src/extensions/extensionRuntime.ts', '    if (executable.length === 0)', '    if (generation !== this.generation || this.disposed) throw new Error("Extension permissions changed during startup.");\n    if (executable.length === 0)');
await edit('apps/server/src/extensions/extensionRuntime.ts', '  async stopAll(): Promise<void> {\n', '  async stopAll(): Promise<void> {\n    this.generation++;\n    await Promise.allSettled(this.starts.values());\n');
await edit('apps/server/src/extensions/extensionRuntime.ts', '      const file = path.join(slot.storage, "values", `${hash}.json`);', '      // Mementos are broker-owned, outside child-writable mounts. Global state\n      // is shared across workspaces; workspace state remains explicitly scoped.\n      const scope = params.shared === true ? "global" : createHash("sha256").update(slot.cwd).digest("hex");\n      const values = path.join(this.manager.home, "mementos", scope);\n      await mkdir(values, { recursive: true, mode: 0o700 });\n      const file = path.join(values, `${hash}.json`);');
await edit('apps/server/src/extensions/extensionRuntime.ts', 'const temporary = path.join(slot.storage, "values", `.value-${randomUUID()}.json`);', 'const temporary = path.join(values, `.value-${randomUUID()}.json`);');
await edit('apps/server/src/extensions/extensionRuntime.ts', '        const contents = await readFile(file, "utf8").catch', '        const info = await lstat(file).catch(() => undefined);\n        if (info && (!info.isFile() || info.size > 1_000_000)) throw new Error("Invalid extension memento file.");\n        const contents = await readFile(file, "utf8").catch');
console.log('Integrated runtime RPC, pinned host boundary, private protocol pipe, startup authorization fence and broker-owned mementos.');

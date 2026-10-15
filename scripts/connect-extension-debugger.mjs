// Temporary exact-anchor integration; omitted from the normalized application tree.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const contents = await readFile(file, "utf8");
  if (contents.split(before).length !== 2) throw new Error(`Expected one debugger integration anchor in ${file}: ${before}`);
  await writeFile(file, contents.replace(before, after));
}
const host = "apps/server/src/extensions/host/entry.mjs";
await edit(host, 'import { createWriteStream } from "node:fs";', 'import { createWriteStream } from "node:fs";\nimport { NativeExtensionDebugAdapter } from "./debugAdapter.mjs";\nimport { score } from "@code-oss/vs/editor/common/languageSelector.js";');
await edit(host, 'function installMainThreadActors() {', `const extensionDebug = new NativeExtensionDebugAdapter(
  () => actor("ExtHostDebugService"),
  async (type) => {
    await actor("ExtHostExtensionService").$activateByEvent("onDebug", 0);
    await actor("ExtHostExtensionService").$activateByEvent(\`onDebugResolve:\${type}\`, 0);
    for (const extension of initialization.extensions) {
      if (!(extension.manifest.contributes?.debuggers ?? []).some((contribution) => contribution.type === type)) continue;
      const id = new ExtensionIdentifier(\`\${extension.manifest.publisher}.\${extension.manifest.name}\`.toLowerCase());
      await host._extensionService.activateByIdWithErrors(id, { startup: false, extensionId: id, activationEvent: \`onDebugResolve:\${type}\` });
    }
  },
  () => initialization,
  () => documents,
);
function selectedProviders(params) {
  if (!params.path) return [...providers.values()];
  const resource = URI.file(params.path);
  const document = documents.get(resource.toString());
  if (!document) throw new Error("Synchronize the native document before selecting its extension providers.");
  return [...providers.values()].filter((provider) => provider.kind === "workspaceSymbols" || score(provider.selector, resource, document.languageId, true, undefined, undefined) > 0);
}
function installMainThreadActors() {`);
let source = await readFile(host, "utf8");
const begin = source.indexOf("    MainThreadDebugService: {");
const end = source.indexOf("\n  };\n  for (const [name, identifier]", begin);
if (begin < 0 || end < 0) throw new Error("Debug actor boundaries changed.");
source = source.slice(0, begin) + "    MainThreadDebugService: extensionDebug.mainThread()," + source.slice(end);
await writeFile(host, source);
await edit(host, '    case "state":\n      return {\n        active: [...activeExtensions],\n        providers: [...providers.values()],', '    case "debug":\n      return extensionDebug.dispatch(message.params);\n    case "state":\n      return {\n        active: [...activeExtensions],\n        providers: selectedProviders(message.params),');
await edit(host, '    case "shutdown":\n      host.terminate', '    case "shutdown":\n      await extensionDebug.shutdown();\n      host.terminate');
const sandbox = "apps/server/src/platform/extensionHostSandbox.ts";
await edit(sandbox, 'for (const directory of ["/usr", "/bin", "/lib", "/lib64"])', 'for (const directory of ["/usr", "/bin", "/lib", "/lib64", "/etc/os-release", "/etc/lsb-release"])');
const runtime = "apps/server/src/extensions/extensionRuntime.ts";
await edit(runtime, '        if (method === "language") {', '        if (method === "language" || (method === "state" && params.relativePath !== undefined)) {');
await edit(runtime, '          z.number().int().nonnegative().parse(params.handle);', '          if (method === "language") z.number().int().nonnegative().parse(params.handle);');
const store = "apps/web/src/components/codeEditor/editorDebugStore.ts";
await edit(store, 'type Watch = {', `export interface EditorDebugBackend {
  start: (input: EditorDebugStartInput, options?: { signal?: AbortSignal }) => Promise<{ sessionId: string }>;
  action: (input: EditorDebugActionInput) => Promise<EditorDebugActionResult>;
  poll: (input: { sessionId: string; after: number }) => Promise<EditorDebugSnapshot>;
}

type Watch = {`);
await edit(store, '  private state = initial();', '  private state = initial();\n  private selectedBackend: EditorDebugBackend | undefined;');
await edit(store, '  private api() {', '  private api() {\n    if (this.selectedBackend) return this.selectedBackend;');
await edit(store, '  async start(input: Omit<EditorDebugStartInput, "cwd" | "breakpoints">) {', '  async start(input: Omit<EditorDebugStartInput, "cwd" | "breakpoints">, backend?: EditorDebugBackend) {');
await edit(store, '    const api = this.api();\n    this.launchController', '    this.selectedBackend = backend;\n    const api = this.api();\n    this.launchController');
const bridge = "apps/web/src/components/codeEditor/editorExtensionBridge.ts";
await edit(bridge, 'import { monaco } from "./editorRuntime";', 'import { monaco } from "./editorRuntime";\nimport { getEditorDebugStore } from "./editorDebugStore";\nimport { extensionDebugBackend } from "./extensionDebugBackend";');
source = await readFile(bridge, "utf8");
const matchesBegin = source.indexOf("function matches(provider:");
const matchesEnd = source.indexOf("/** Reject clamped", matchesBegin);
if (matchesBegin < 0 || matchesEnd < 0) throw new Error("Local selector adapter boundary changed.");
source = source.slice(0, matchesBegin) + source.slice(matchesEnd);
const pickerBegin = source.indexOf('      rows.push({\n        id: "extensions:format",');
const pickerEnd = source.indexOf('      rows.push({\n        id: "extensions:commands",', pickerBegin);
if (pickerBegin < 0 || pickerEnd < 0) throw new Error("Formatter picker boundary changed.");
source = source.slice(0, pickerBegin) + `      rows.push({
        id: "extensions:format", label: "Format with extension…",
        run: async () => {
          await this.sync();
          const result = extensionRecord(await this.invoke("state", { relativePath: entry.relativePath }));
          show("Extension formatters", list(result.providers).map(extensionRecord).filter((provider) => provider.kind === "format").map((provider) => {
            const metadata = list(provider.metadata), label = metadata.at(-1);
            return { id: String(integer(provider.handle)), label: typeof label === "string" ? label : "Extension formatter", run: () => this.format(entry, integer(provider.handle)) };
          }));
        },
      });
      rows.push({
        id: "extensions:debug", label: "Start extension debugger…", detail: ".vscode/launch.json",
        run: async () => {
          await this.sync();
          const configurations = list(await this.debug({ operation: "configurations" }));
          show("Extension debug configurations", configurations.map((value) => {
            const configuration = extensionRecord(value);
            const id = text(configuration.id);
            return { id, label: text(configuration.name), detail: text(configuration.type), run: async () => {
              await getEditorDebugStore(this.client, this.cwd).start({ request: "launch", program: entry.relativePath, args: [], port: 0, stopOnEntry: false }, extensionDebugBackend(this, id, entry.relativePath));
            } };
          }));
        },
      });
` + source.slice(pickerEnd);
await writeFile(bridge, source);
await edit(bridge, 'method: "activate" | "language" | "command" | "state",', 'method: "activate" | "language" | "command" | "state" | "debug",');
await edit(bridge, '  async format(entry: EditorModelEntry, handle: number): Promise<void> {', '  debug(params: Record<string, unknown>): Promise<unknown> { return this.invoke("debug", params); }\n  async format(entry: EditorModelEntry, handle: number): Promise<void> {');
console.log("Connected upstream debug adapters to the existing Synara panel, authoritative selectors, and read-only OS release metadata.");

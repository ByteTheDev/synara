// Temporary integration script. Removed from the reviewed application tree.
import { readFile, writeFile } from "node:fs/promises";
await import("./extend-native-language-bridge.mjs");
async function edit(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Expected one integration anchor in ${file}: ${before}`);
  await writeFile(file, source.replace(before, after));
}
const host = "apps/server/src/extensions/host/entry.mjs";
await edit(host, 'import { requestLanguageProvider } from "./languageAdapter.mjs";', 'import { requestLanguageProvider } from "./languageAdapter.mjs";\nimport { nativeFileSystem } from "./fileSystemAdapter.mjs";');
let contents = await readFile(host, "utf8");
let begin = contents.indexOf("    MainThreadFileSystem: {");
let end = contents.indexOf("    MainThreadFileSystemEventService:", begin);
if (begin < 0 || end < 0) throw new Error("Upstream filesystem actor boundaries changed.");
await writeFile(host, contents.slice(0, begin) + '    MainThreadFileSystem: nativeFileSystem(() => initialization, parent),\n' + contents.slice(end));
await edit(host, 'import { VSBuffer } from "@code-oss/vs/base/common/buffer.js";\n', '');
const runtime = "apps/server/src/extensions/extensionRuntime.ts";
contents = await readFile(runtime, "utf8");
begin = contents.indexOf('    if (["fs.stat", "fs.read", "fs.readdir"].includes(method)) {');
end = contents.indexOf('    if (method === "fs.write") {', begin);
if (begin < 0 || end < 0) throw new Error("Runtime filesystem broker boundaries changed.");
contents = contents.slice(0, begin) + `    if (["fs.stat", "fs.read", "fs.readdir"].includes(method)) {
      throw new Error("Extension file reads must execute inside the OS sandbox.");
    }
` + contents.slice(end);
// Child-controlled storage must never be dereferenced by the more privileged broker.
const storageWrite = /      if \(pathWithin\(slot\.storage, filename\)\) \{[\s\S]*?\n      \}/;
if (!storageWrite.test(contents)) throw new Error("Runtime storage write boundary changed.");
contents = contents.replace(storageWrite, '      if (pathWithin(slot.storage, filename)) throw new Error("Extension storage writes must execute inside the OS sandbox.");');
await writeFile(runtime, contents);
const bridge = "apps/web/src/components/codeEditor/editorExtensionBridge.ts";
await edit(bridge, 'import { monaco } from "./editorRuntime";', 'import { monaco } from "./editorRuntime";\nimport { registerNativeExtensionProviders, applyNativeExtensionDiagnostics } from "./extensionLanguageProviders";');
await edit(bridge, '  private readonly providers = new Map<number, Provider>();', '  private readonly providers = new Map<number, Provider>();\n  private languageRegistrations: monaco.IDisposable[] = [];\n  private readonly diagnosticOwners = new Set<string>();');
await edit(bridge, '      } else if (event.event === "commands")', `        this.languageRegistrations.forEach((registration) => registration.dispose());
        this.languageRegistrations = registerNativeExtensionProviders(this, [...this.providers.values()]);
      } else if (event.event === "diagnostics") {
        const data = extensionRecord(body);
        this.diagnosticOwners.add(text(data.owner));
        applyNativeExtensionDiagnostics(this, body);
      } else if (event.event === "commands")`);
await edit(bridge, '  async stop(): Promise<void> {', `  async provide(entry: EditorModelEntry, handle: number, params: Record<string, unknown>, token: monaco.CancellationToken): Promise<unknown> {
    if (this.state.phase !== "running" || token.isCancellationRequested) return undefined;
    const version = entry.model.getVersionId();
    await this.sync();
    if (token.isCancellationRequested) return undefined;
    const result = await this.invoke("language", { ...params, handle, relativePath: entry.relativePath });
    if (token.isCancellationRequested || entry.model.isDisposed() || entry.model.getVersionId() !== version) return undefined;
    return result;
  }
  async stop(): Promise<void> {
    this.languageRegistrations.forEach((registration) => registration.dispose());
    this.languageRegistrations = [];
    for (const owner of this.diagnosticOwners) applyNativeExtensionDiagnostics(this, { owner, entries: [] });
    this.diagnosticOwners.clear();`);
const providers = "apps/web/src/components/codeEditor/extensionLanguageProviders.ts";
await edit(providers, 'const resource = typeof value === "string" ? monaco.Uri.parse(value) : monaco.Uri.revive(object(value) as unknown as monaco.UriComponents);', 'const data = typeof value === "string" ? null : object(value);\n  const resource = typeof value === "string" ? monaco.Uri.parse(value) : monaco.Uri.from({ scheme: string(data!.scheme), path: string(data!.path), ...(typeof data!.authority === "string" ? { authority: data!.authority } : {}) });');
console.log("Connected native language providers/diagnostics; restricted broker filesystem operations to the authoritative workspace writer.");

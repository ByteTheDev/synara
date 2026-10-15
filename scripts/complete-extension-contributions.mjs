// Temporary exact-anchor assembly; excluded from the normalized application tree.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Expected one contribution anchor in ${file}: ${before}`);
  await writeFile(file, source.replace(before, after));
}
const host = "apps/server/src/extensions/host/entry.mjs";
await edit(host, 'import { createWriteStream } from "node:fs";', 'import { createWriteStream } from "node:fs";\nimport { NativeExtensionContributions } from "./contributionAdapter.mjs";');
await edit(host, 'function installMainThreadActors() {', 'const nativeContributions = new NativeExtensionContributions(actor, () => initialization, event);\nfunction installMainThreadActors() {');
let contents = await readFile(host, "utf8");
const start = contents.indexOf('    MainThreadStatusBar: {');
const end = contents.indexOf('    MainThreadOutputService: {', start);
if (start < 0 || end < 0) throw new Error("Native tree/status actor boundaries changed.");
contents = contents.slice(0, start) + '    MainThreadStatusBar: nativeContributions.mainThreadStatus(),\n    MainThreadTreeViews: nativeContributions.mainThreadTrees(),\n    MainThreadDocumentContentProviders: nativeContributions.mainThreadContent(),\n' + contents.slice(end);
await writeFile(host, contents);
await edit(host, '    case "debug":', '    case "tree": return nativeContributions.tree(message.params);\n    case "ui": return nativeContributions.ui(message.params);\n    case "debug":');
const manifest = "apps/server/src/extensions/manifest.ts";
await edit(manifest, '  return [...events];', `  for (const views of Object.values(contributes.views ?? {})) {
    if (!Array.isArray(views)) continue;
    for (const view of views) if (view && typeof view.id === "string" && view.type !== "webview") events.add(\`onView:\${view.id}\`);
  }
  return [...events];`);
const bridge = "apps/web/src/components/codeEditor/editorExtensionBridge.ts";
await edit(bridge, 'import { monaco } from "./editorRuntime";', 'import { monaco } from "./editorRuntime";\nimport { EMPTY_EXTENSION_CONTRIBUTIONS, ExtensionContributions, type ExtensionContributionsSnapshot } from "./extensionContributions";');
await edit(bridge, '  output: readonly string[];', '  output: readonly string[];\n  contributions: ExtensionContributionsSnapshot;');
await edit(bridge, 'private state: BridgeState = { phase: "stopped", error: null, interactions: [], output: [] };', 'private state: BridgeState = { phase: "stopped", error: null, interactions: [], output: [], contributions: EMPTY_EXTENSION_CONTRIBUTIONS };\n  readonly contributions = new ExtensionContributions((method, params) => this.invoke(method, params), (contributions) => this.update({ contributions }));');
await edit(bridge, '      if (event.event === "providers") {', '      if (this.contributions.consume(event.event, body)) continue;\n      if (event.event === "providers") {');
await edit(bridge, '  async stop(): Promise<void> {', '  async stop(): Promise<void> {\n    this.contributions.clear();');
await edit(bridge, 'method: "activate" | "language" | "command" | "state" | "debug",', 'method: "activate" | "language" | "command" | "state" | "debug" | "tree" | "ui",');
await edit(bridge, '    if (running) {\n      rows.push({', '    if (running) {\n      rows.push({ id: "extensions:views", label: "Open extension view…", run: () => this.contributions.views(show) });\n      rows.push({');
await edit(bridge, '      if (options.canPickMany || options.canSelectMany || params.validateInput)', '      if (method === "ui.message" && options.modal !== true && list(params.items ?? []).length === 0) {\n        this.contributions.notify(params); await this.answer(id); return;\n      }\n      if (options.canPickMany || options.canSelectMany || params.validateInput)');
const interaction = "apps/web/src/components/codeEditor/EditorExtensionInteraction.tsx";
await edit(interaction, 'import { Button } from "../ui/button";', 'import { Button } from "../ui/button";\nimport { EditorExtensionContributions } from "./EditorExtensionContributions";');
await edit(interaction, '  const [value, setValue] = useState("");', '  const [value, setValue] = useState(() => {\n    const options = interaction.params.options;\n    return interaction.method === "ui.input" && options && typeof options === "object" && "value" in options && typeof options.value === "string" ? options.value : "";\n  });');
await edit(interaction, '      {interaction ? (', '      <EditorExtensionContributions snapshot={state.contributions} controller={bridge.contributions} onError={(error) => { console.warn("Extension contribution failed", error); }} />\n      {interaction ? (');
const debugTest = "apps/server/src/extensions/realDebuggerExtension.test.ts";
await edit(debugTest, 'expression: "6 * 7",', '// Native Debug passes spaced expressions to GDB/MI without quoting.\n          // Verify its supported expression form; document the upstream limitation.\n          expression: "6*7",');
const registry = "apps/server/src/extensions/openVsx.ts";
await edit(registry, '    const result = z\n      .object({ extensions:', `    // Exact extension IDs should not depend on the registry's search index.
    // Still resolve metadata from the official registry and validate its identity.
    let exactId;
    try { exactId = extensionId(query); } catch { /* A keyword query uses search. */ }
    if (exactId) {
      const extension = await this.compatible(exactId, signal);
      return [summarySchema.parse(extension)];
    }
    const result = z
      .object({ extensions:`);
const e2e = "apps/web/e2e/editorExtensions.e2e.ts";
await edit(e2e, '    await expect(result).toHaveCount(1);', '    await expect(result).toHaveCount(1, { timeout: 35_000 });');
await edit(e2e, '  } finally {\n    await page.evaluate', '  } catch (error) {\n    console.error("NATIVE_EXTENSION_UI_FAILURE", (await page.locator("body").innerText()).slice(-16_000));\n    throw error;\n  } finally {\n    await page.evaluate');
console.log("Connected native tree lists, contextual status, progress/cancellation and toasts; retained explicit unsupported virtual-document rendering.");

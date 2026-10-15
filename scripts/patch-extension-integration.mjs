// Bounded candidate repair. Omit this file from the published application tree.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const contents = await readFile(file, "utf8");
  if (contents.split(before).length !== 2) throw new Error(`Expected one anchor in ${file}: ${before}`);
  await writeFile(file, contents.replace(before, after));
}
const host = "apps/server/src/extensions/host/entry.mjs";
await edit(host, 'import { createWriteStream } from "node:fs";', 'import { createWriteStream } from "node:fs";\nimport { ILoggerService } from "@code-oss/vs/platform/log/common/log.js";\nimport { ExtHostLoggerService as BrokeredLoggerService } from "@code-oss/vs/workbench/api/common/extHostLoggerService.js";');
await edit(host, 'registerSingleton(ILogService, NullLogService, InstantiationType.Eager);', 'registerSingleton(ILogService, NullLogService, InstantiationType.Eager);\n// Use upstream RPC logging instead of a platform-native spdlog dependency.\nregisterSingleton(ILoggerService, BrokeredLoggerService, InstantiationType.Eager);');
await edit(host, '    MainThreadLanguageFeatures: language,', `    MainThreadLanguageFeatures: language,
    // No Synara agent tools are exposed to editor extensions. This is an empty
    // discovery catalog, not permission to invoke or register agent tools.
    MainThreadLanguageModelTools: { $getTools() { return []; } },
    MainThreadLogger: {
      $createLogger(resource, options) { event("output.logger", { resource, options }); },
      $log(resource, messages) { event("output.log", { resource, messages }); },
      $flush() { return new Promise((resolve, reject) => protocolOutput.write("", (error) => error ? reject(error) : resolve())); },
      $setVisibility(resource, visible) { event("output.visibility", { resource, visible }); },
    },`);
const bridge = "apps/web/src/components/codeEditor/editorExtensionBridge.ts";
await edit(bridge, 'type Attachment = { entry: EditorModelEntry; editable: boolean };', 'type Attachment = { entry: EditorModelEntry; editable: boolean; owner: object };');
await edit(bridge, 'ownsInteraction(entry: EditorModelEntry | null): boolean {\n    return [...this.attachments][0]?.entry === entry;', 'ownsInteraction(owner: object | null): boolean {\n    return [...this.attachments][0]?.owner === owner;');
await edit(bridge, 'retain(entry: EditorModelEntry, editable: boolean): () => void {\n    const attachment = { entry, editable };', 'retain(entry: EditorModelEntry, editable: boolean, owner: object = entry): () => void {\n    const attachment = { entry, editable, owner };');
const surface = "apps/web/src/components/codeEditor/MonacoEditorSurface.tsx";
await edit(surface, '  const client = useQueryClient();', '  const client = useQueryClient();\n  const extensionInteractionOwner = useRef({});');
await edit(surface, 'return extensionBridge.retain(controller.entry, !props.readOnly);', 'return extensionBridge.retain(controller.entry, !props.readOnly, extensionInteractionOwner.current);');
await edit(surface, '<EditorExtensionInteraction bridge={extensionBridge} entry={controller?.entry ?? null} />', '<EditorExtensionInteraction bridge={extensionBridge} entry={controller?.entry ?? null} owner={extensionInteractionOwner.current} />');
const interaction = "apps/web/src/components/codeEditor/EditorExtensionInteraction.tsx";
await edit(interaction, '  entry,\n}: {', '  entry,\n  owner,\n}: {');
await edit(interaction, '  entry: EditorModelEntry | null;', '  entry: EditorModelEntry | null;\n  owner?: object;');
await edit(interaction, 'bridge.ownsInteraction(entry)', 'bridge.ownsInteraction(owner ?? entry)');
console.log("Repaired upstream startup discovery and logging; assigned each native interaction exactly one view owner.");

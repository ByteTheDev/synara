// Temporary exact-anchor integration. Excluded from the application tree.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Expected one edit-provider anchor in ${file}: ${before}`);
  await writeFile(file, source.replace(before, after));
}
const host = "apps/server/src/extensions/host/languageAdapter.mjs";
await edit(host, 'import { URI } from "@code-oss/vs/base/common/uri.js";', 'import { URI } from "@code-oss/vs/base/common/uri.js";\nimport { snapshotWorkspaceEdit } from "./workspaceEditAdapter.mjs";');
await edit(host, '  const document = documents.get(resource.toString());', '  const document = documents.get(resource.toString());\n  const snapshots = new Map(documents);');
await edit(host, 'return result.actions.filter((action) => action.edit && !action.command);', 'return result.actions.filter((action) => action.edit && !action.command).map((action) => ({ ...action, edit: snapshotWorkspaceEdit(action.edit, snapshots) }));');
const source = await readFile(host, "utf8");
const rename = /case "rename":\s*return target\.\$provideRenameEdits\(handle, resource, position, params\.newName, cancellation\);/;
if (!rename.test(source)) throw new Error("Rename provider call changed.");
await writeFile(host, source.replace(rename, 'case "rename":\n      return snapshotWorkspaceEdit(await target.$provideRenameEdits(handle, resource, position, params.newName, cancellation), snapshots);'));
const frontend = "apps/web/src/components/codeEditor/extensionLanguageProviders.ts";
await edit(frontend, 'import { editorEntry, editorUri, type EditorModelEntry } from "./editorModels";', 'import { editorEntry, editorUri, monacoWorkspaceEdits, type EditorModelEntry } from "./editorModels";\nimport type { EditorFileEdits } from "@synara/contracts";');
await edit(frontend, '/** Registrations only target this Synara client\'s workspace, never unrelated models. */', `async function workspaceEdit(client: NativeExtensionLanguageClient, source: EditorModelEntry, value: unknown): Promise<monaco.languages.WorkspaceEdit> {
  const result = object(value);
  const groups = new Map<string, EditorFileEdits>();
  for (const raw of array(result.edits)) {
    const item = object(raw), resource = documentUri(client, item.resource);
    const model = monaco.editor.getModel(resource);
    const target = model && editorEntry(model);
    if (!target || target.client !== client.client || target.cwd !== client.cwd) throw new Error("Open every extension edit target before applying it.");
    const expectedContents = string(item.expectedContents);
    if (target.model.getValue() !== expectedContents) throw new Error("An extension edit target changed. Nothing was modified.");
    const edit = object(item.textEdit), range = extensionRange(edit.range);
    if (!monaco.Range.equalsRange(range, target.model.validateRange(range))) throw new Error("Extension edit range exceeds its document.");
    const start = target.model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn });
    const end = target.model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn });
    const group = groups.get(target.relativePath) ?? { relativePath: target.relativePath, expectedContents, edits: [] };
    if (group.expectedContents !== expectedContents) throw new Error("Extension edit versions disagree.");
    groups.set(target.relativePath, { ...group, edits: [...group.edits, { start, length: end - start, newText: string(edit.text) }] });
  }
  return monacoWorkspaceEdits(source, [...groups.values()]);
}

/** Registrations only target this Synara client's workspace, never unrelated models. */`);
await edit(frontend, '    else if (provider.kind === "folding")', `    else if (provider.kind === "rename") disposables.push(monaco.languages.registerRenameProvider(selector, {
      provideRenameEdits: async (model, position, newName, token) => {
        const source = entry(model);
        if (!source) return undefined;
        const value = await invoke(model, token, { position, newName });
        return value == null ? undefined : workspaceEdit(client, source, value);
      },
    }));
    else if (provider.kind === "codeActions") disposables.push(monaco.languages.registerCodeActionProvider(selector, {
      provideCodeActions: async (model, range, context, token) => {
        const source = entry(model);
        if (!source) return undefined;
        const value = await invoke(model, token, { range, context: { trigger: context.trigger, ...(context.only ? { only: context.only } : {}) } });
        if (value == null) return undefined;
        const actions: monaco.languages.CodeAction[] = [];
        for (const raw of array(value)) {
          const item = object(raw);
          if (item.command || item.disabled || !item.edit) continue;
          actions.push({ title: string(item.title), edit: await workspaceEdit(client, source, item.edit),
            ...(typeof item.kind === "string" ? { kind: item.kind } : {}), ...(item.isPreferred === true ? { isPreferred: true } : {}) });
        }
        return { actions, dispose: () => undefined };
      },
    }));
    else if (provider.kind === "folding")`);
console.log("Connected code actions and rename through native prevalidation and versioned workspace edits.");

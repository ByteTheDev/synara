// Temporary extraction/integration; final tree contains only the shared test helper.
import { readFile, writeFile } from "node:fs/promises";
const file = "apps/web/e2e/editorIntelligence.e2e.ts";
let source = await readFile(file, "utf8");
const start = source.indexOf("async function seed(page: Page) {");
const end = source.indexOf("async function editorVisible", start);
if (start < 0 || end < 0) throw new Error("Native acceptance bootstrap boundaries changed.");
let helper = source.slice(start, end)
  .replace("async function seed(page: Page) {", "export async function seedEditorProject(page: Page, workspace: string): Promise<string> {")
  .replace("  await page\n    .evaluate", "  return page\n    .evaluate");
const tail = `    .then((id) => {
      threadId = id;
    });`;
if (!helper.includes(tail)) throw new Error("Native acceptance seed return anchor changed.");
helper = helper.replace(tail, ";");
await writeFile("apps/web/e2e/editorAcceptanceFixture.ts", 'import { expect, type Page } from "playwright/test";\n\n' + helper);
source = 'import { seedEditorProject } from "./editorAcceptanceFixture";\n' + source.slice(0, start) + 'async function seed(page: Page) {\n  threadId = await seedEditorProject(page, workspace);\n}\n' + source.slice(end);
await writeFile(file, source);
const runtime = "apps/server/src/extensions/extensionRuntime.ts";
let text = await readFile(runtime, "utf8");
const anchor = '        const snapshot = slot.snapshots.get(filename);';
const begin = text.indexOf('if (method === "documents.workspaceEdit")');
const offset = text.indexOf(anchor, begin);
if (begin < 0 || offset < 0) throw new Error("Workspace edit version boundary changed.");
text = text.slice(0, offset + anchor.length) + '\n        if (!snapshot) throw new Error("Open and synchronize every workspace edit target before changing it.");' + text.slice(offset + anchor.length);
await writeFile(runtime, text);
console.log("Reused the native app bootstrap and added a fail-closed snapshot requirement for every workspace edit target.");

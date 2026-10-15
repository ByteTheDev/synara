// Temporary exact-anchor integration; omitted from the application candidate.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Expected one integration anchor in ${file}: ${before}`);
  await writeFile(file, source.replace(before, after));
}
const host = "apps/server/src/extensions/host/entry.mjs";
await edit(host, 'import { createWriteStream } from "node:fs";', 'import { createWriteStream } from "node:fs";\nimport { requestLanguageProvider } from "./languageAdapter.mjs";');
const source = await readFile(host, "utf8");
const begin = source.indexOf("async function language(params) {");
const end = source.indexOf("async function dispatch(message) {", begin);
if (begin < 0 || end < 0) throw new Error("Host language boundaries changed.");
await writeFile(host, source.slice(0, begin) + `async function language(params) {
  const provider = providers.get(params.handle);
  if (!provider) throw new Error("Extension language provider is no longer registered.");
  return requestLanguageProvider(actor("ExtHostLanguageFeatures"), provider, params, documents);
}
` + source.slice(end));
await edit(host, 'import { CancellationToken } from "@code-oss/vs/base/common/cancellation.js";\n', '');
console.log("Connected Code-OSS language selectors and self-contained provider results with cache cleanup.");

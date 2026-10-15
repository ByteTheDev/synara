// Temporary final candidate assembly; omitted from publication.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Expected one publication anchor in ${file}: ${before}`);
  await writeFile(file, source.replace(before, after));
}
const e2e = "apps/web/e2e/editorExtensions.e2e.ts";
let source = await readFile(e2e, "utf8");
const start = source.indexOf("async function capture(");
const end = source.indexOf("\ntest(", start);
if (start < 0 || end < 0) throw new Error("Shared native extension acceptance controls changed.");
let helpers = source.slice(start, end);
for (const name of ["capture", "command", "bridgePhase"]) helpers = helpers.replace(`async function ${name}(`, `export async function ${name}(`);
await writeFile("apps/web/e2e/extensionAcceptanceControls.ts", 'import type { Page, TestInfo } from "playwright/test";\n\n' + helpers);
source = source.slice(0, start) + source.slice(end);
source = source.replace('import { test, expect, type Page, type TestInfo } from "playwright/test";', 'import { test, expect } from "playwright/test";\nimport { capture, command, bridgePhase } from "./extensionAcceptanceControls";');
await writeFile(e2e, source);
await edit("apps/web/playwright.extensions.config.ts", 'testMatch: "editorExtensions.e2e.ts",', 'testMatch: ["editorExtensions.e2e.ts", "editorExtensionDebug.e2e.ts"],');
const build = "scripts/build-code-oss-host.mjs";
await edit(build, 'import { createHash } from "node:crypto";', 'import { createHash } from "node:crypto";\nimport { writeCodeOssNotices } from "./code-oss-notices.mjs";');
await edit(build, 'const bundle = await readFile(path.join(output, "extension-host.mjs"));', 'await writeCodeOssNotices(Object.keys(result.metafile.inputs), source, output);\nconst bundle = await readFile(path.join(output, "extension-host.mjs"));');
const runtime = "apps/server/src/extensions/extensionRuntime.ts";
await edit(runtime, 'const runtimeManifest =', 'class CodeOssRuntimeNotBuiltError extends Error {}\n\nconst runtimeManifest =');
await edit(runtime, '    return this.manager.request(owner, input, signal);', `    if (input.operation === "list" && !this.runtimeFile && process.platform === "linux") {
      // Detect a verified installed runtime without launching extension code.
      try { await this.findRuntime(); }
      catch (error) { if (!(error instanceof CodeOssRuntimeNotBuiltError)) throw error; }
    }
    return this.manager.request(owner, input, signal);`);
await edit(runtime, '    throw new Error(\n      "The optional Code-OSS runtime is not built.', '    throw new CodeOssRuntimeNotBuiltError(\n      "The optional Code-OSS runtime is not built.');
await edit(runtime, '    return this.runtimeFile ? "stopped" : "not-built";', '    if ([...this.slots.values()].some((slot) => slot.state === "failed")) return "failed";\n    return this.runtimeFile ? "stopped" : "not-built";');
const fixture = "apps/server/src/extensions/realRuntime.test.ts";
await edit(fixture, '    const owner = "runtime-fixture-owner";\n    try {', '    const owner = "runtime-fixture-owner";\n    try {\n      expect((await runtime.request(owner, { operation: "list" })).runtime).toBe("stopped");');
console.log("Prepared durable build/CI documentation, real native debugger UI evidence and lazy runtime detection.");

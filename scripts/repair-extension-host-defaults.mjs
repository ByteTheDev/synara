// Temporary repair assembly, excluded from the final application tree.
import { readFile, writeFile } from "node:fs/promises";
async function edit(file, before, after) {
  const contents = await readFile(file, "utf8");
  if (contents.split(before).length !== 2) throw new Error(`Expected one repair anchor in ${file}: ${before}`);
  await writeFile(file, contents.replace(before, after));
}
const host = "apps/server/src/extensions/host/entry.mjs";
await edit(host, 'import { createWriteStream } from "node:fs";', 'import { createWriteStream } from "node:fs";\nimport { getDefaultValue } from "@code-oss/vs/platform/configuration/common/configurationRegistry.js";');
await edit(host, 'if (property && "default" in property) defaults[key] = property.default;', 'if (property) defaults[key] = "default" in property ? property.default : getDefaultValue(property.type);');
await edit(host, '    MainThreadLanguageFeatures: language,', `    MainThreadLanguageFeatures: language,
    // Capability announcements do not authorize terminal/task execution or
    // replace Synara's explorer/search. Record them for compatibility reporting.
    MainThreadTerminalService: {
      $registerProcessSupport(supported) { event("capability.terminalProcess", { supported }); },
    },
    MainThreadTask: {
      $registerSupportedExecutions(...capabilities) { event("capability.taskExecutions", capabilities); },
      $registerTaskSystem(key, system) { event("capability.taskSystem", { key, system }); },
    },
    MainThreadSearch: {
      $registerTextSearchProvider(handle, scheme) { event("capability.textSearch", { handle, scheme }); },
      $registerFileSearchProvider(handle, scheme) { event("capability.fileSearch", { handle, scheme }); },
      $unregisterProvider(handle) { event("capability.searchRemoved", { handle }); },
    },`);
await edit(host, '    MainThreadLanguages: {', '    MainThreadLanguages: {\n      $setLanguageStatus(handle, status) { event("languageStatus.set", { handle, status }); },\n      $removeLanguageStatus(handle) { event("languageStatus.remove", { handle }); },');
const fixture = "apps/server/src/extensions/realHost.test.ts";
await edit(fixture, 'import os from "node:os";', 'import os from "node:os";\nimport { applyHostEditFixture } from "./hostEditFixture";');
await edit(fixture, `expect(edits.map((edit) => edit.text).join("\\n")).toContain(
          'const value = { hello: "world" };',
        );`, `expect(applyHostEditFixture(contents, edits)).toBe('const value = { hello: "world" };\\n');`);
await edit(fixture, 'expect(changed.map((edit) => edit.text).join("\\n")).toContain("const next = { n: 2 };");', 'expect(applyHostEditFixture("const next={n:2}", changed)).toBe("const next = { n: 2 };\\n");\n        expect(diagnosticEvents).toEqual([]);');
const fsAdapter = "apps/server/src/extensions/host/fileSystemAdapter.mjs";
let source = await readFile(fsAdapter, "utf8");
source = source.replace('  writeFile,\n', '  open,\n');
if (!source.includes('  open,\n')) throw new Error("Filesystem import repair anchor changed.");
const start = source.indexOf('      await writeFile(filename, bytes, {');
const end = source.indexOf('\n      });', start);
if (start < 0 || end < 0) throw new Error("Storage write repair anchor changed.");
source = source.slice(0, start) + `      const handle = await open(filename, options.overwrite === false ? "wx" : options.create === false ? "r+" : "w", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.truncate(bytes.length);
      } finally {
        await handle.close();
      }` + source.slice(end + '\n      });'.length);
await writeFile(fsAdapter, source);
console.log("Repaired schema-derived defaults, capability announcements and minimal-edit acceptance without disabling assertions.");

// Temporary integration assembly; excluded from the normalized application tree.
import { readFile, writeFile } from "node:fs/promises";
await import("./prepare-extension-evidence.mjs");
const host = "apps/server/src/extensions/host/entry.mjs";
let contents = await readFile(host, "utf8");
const activation = "host._extensionService.activateByEvent(";
if (!contents.includes(activation)) throw new Error("Expected upstream activation repair anchor.");
contents = contents.replaceAll(activation, 'actor("ExtHostExtensionService").$activateByEvent(');
await writeFile(host, contents);
const fixture = "apps/server/src/extensions/realHost.test.ts";
contents = await readFile(fixture, "utf8");
const before = '        const changed = formatEdits.parse(\n          await connection.request("language", { handle: formatter!.handle, path: documentPath }),\n        );';
if (contents.split(before).length !== 2) throw new Error("Expected dirty-document formatter fixture anchor.");
contents = contents.replace(before, `        // Active-workspace discovery replaces the global provider. Resolve
        // the live contribution again rather than reusing a disposed handle.
        const refreshed = state.parse(await connection.request("state", {}));
        const currentFormatter = refreshed.providers.find((entry) => entry.kind === "format");
        expect(currentFormatter).toBeDefined();
        const changed = formatEdits.parse(
          await connection.request("language", { handle: currentFormatter!.handle, path: documentPath }),
        );`);
await writeFile(fixture, contents);
console.log("Corrected event activation through the actual upstream RPC and exercised dynamic formatter registration.");

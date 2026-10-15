// Temporary assembly; omitted from the normalized application tree.
import { readFile, writeFile } from "node:fs/promises";
await import("./prepare-extension-publication.mjs");
for (const [file, id] of [
  ["apps/web/e2e/editorExtensions.e2e.ts", "esbenp.prettier-vscode"],
  ["apps/web/e2e/editorExtensionDebug.e2e.ts", "webfreak.debug"],
]) {
  let contents = await readFile(file, "utf8");
  const start = contents.lastIndexOf("  } finally {");
  if (start < 0) throw new Error(`Missing fixture cleanup boundary in ${file}`);
  const before = contents.slice(0, start);
  const tail = contents.slice(start);
  const closing = "    }, cwd);";
  if (tail.split(closing).length !== 2) throw new Error(`Ambiguous fixture cleanup boundary in ${file}`);
  contents = before + tail.replace(closing, `      // Remove only this test's package from the isolated acceptance server.
      // Test files share that server, not the user's production state.
      const extensions = ensureNativeApi().editor.extensions;
      const state = await extensions({ operation: "list" });
      const installed = state.extensions.find((entry: { id: string; version: string }) => entry.id === ${JSON.stringify(id)});
      if (installed) await extensions({ operation: "remove", id: installed.id, version: installed.version });
${closing}`);
  await writeFile(file, contents);
}
console.log("Isolated formatter/debugger UI package cleanup without changing shared application behavior.");

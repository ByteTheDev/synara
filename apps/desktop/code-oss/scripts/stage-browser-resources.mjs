import { access, cp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
/** Upstream renderer and workers use both production dependency roots.
 * These are resource directories inside the same Synara installation,
 * not additional applications or native dependency copies. */
export async function stageNativeBrowserResources(runtime) {
  const packages = ["vscode-oniguruma", "@vscode/tree-sitter-wasm"];
  for (const name of packages) await access(join(runtime, "node_modules", name, "package.json"));
  for (const resourceRoot of ["node_modules.asar", "node_modules.asar.unpacked"]) {
    for (const name of packages) {
      const destination = join(runtime, resourceRoot, name);
      await mkdir(join(destination, ".."), { recursive: true });
      await cp(join(runtime, "node_modules", name), destination, {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    await access(join(runtime, resourceRoot, "vscode-oniguruma/release/onig.wasm"));
    await access(join(runtime, resourceRoot, "@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm"));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Pass the prepared native runtime directory.");
  await stageNativeBrowserResources(resolve(process.argv[2]));
}

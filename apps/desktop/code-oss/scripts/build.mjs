/** Build the native workbench as resources of the existing Synara Electron app. */
import { readFile, writeFile, cp, mkdir, access } from "node:fs/promises";
import { resolve, join, relative, sep, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const source = resolve(process.argv[2] ?? "");
const output = resolve(process.argv[3] ?? "");
if (!process.argv[2] || !process.argv[3] || source === output || output.startsWith(source + sep)) {
  throw new Error("Pass separate prepared source and new runtime output directories.");
}
const manifest = JSON.parse(await readFile(join(source, "synara-runtime.json"), "utf8"));
const pin = JSON.parse(await readFile(new URL("../upstream.json", import.meta.url), "utf8"));
if (
  manifest.commit !== pin.commit ||
  manifest.platform !== process.platform ||
  manifest.arch !== process.arch
) {
  throw new Error("Build the Code-OSS native runtime on a matching OS/architecture.");
}
try {
  await access(output);
  throw new Error("Runtime output already exists; use a fresh build directory.");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: source,
      stdio: "inherit",
      windowsHide: true,
      shell: process.platform === "win32" && command === npm,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192", VSCODE_MIXIN_PASSWORD: "" },
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolvePromise() : reject(new Error(`${command} failed (${signal ?? code}).`)),
    );
  });
}
// npm ci preserves the upstream lock; .npmrc selects Synara's existing Electron ABI.
await run(npm, ["ci", "--no-audit", "--no-fund"]);
// The upstream desktop build requires generated API/extension-point indexes and
// the codicon asset before bundling. Use its tasks rather than reproducing them.
await run(npm, [
  "run",
  "gulp",
  "copy-codicons",
  "compile-api-proposal-names",
  "compile-extension-point-names",
]);
// The pinned MIT debug built-ins are fetched from their upstream GitHub releases,
// not Microsoft's Marketplace. Restore Open VSX before bundling product metadata.
const productPath = join(source, "product.json");
const productText = await readFile(productPath, "utf8");
const buildProduct = JSON.parse(productText);
delete buildProduct.extensionsGallery;
try {
  await writeFile(productPath, JSON.stringify(buildProduct, null, "\t") + "\n");
  await run(npm, ["run", "gulp", "compile-extensions-build", "compile-extension-media-build"]);
} finally {
  await writeFile(productPath, productText);
}
// This is the production native workbench, including CSS/NLS, preload, native
// extension host, pty host, shared process and workers. Never set VSCODE_DEV.
await run(process.execPath, [
  "build/next/index.ts",
  "bundle",
  "--target",
  "desktop",
  "--out",
  "out-synara",
  "--nls",
]);
await mkdir(output, { recursive: false });
await cp(join(source, "out-synara"), join(output, "out"), {
  recursive: true,
  verbatimSymlinks: true,
});
await cp(join(source, ".build/extensions"), join(output, "extensions"), {
  recursive: true,
  verbatimSymlinks: true,
});
const { getProductionDependencies } = await import(
  pathToFileURL(join(source, "build/lib/dependencies.ts")).href
);
const dependencies = getProductionDependencies(source).sort((a, b) => a.length - b.length);
const copied = [];
for (const dependency of dependencies) {
  const path = relative(source, dependency);
  if (!path.startsWith("node_modules" + sep) || path.split(sep).includes("..")) {
    throw new Error(`Dependency escapes the native runtime: ${path}`);
  }
  if (copied.some((parent) => dependency.startsWith(parent + sep))) continue;
  await mkdir(dirname(join(output, path)), { recursive: true });
  // Preserve relative runtime links instead of rewriting them to build-machine
  // absolute paths. npm command shims are build tooling, not native app resources.
  await cp(dependency, join(output, path), {
    recursive: true,
    verbatimSymlinks: true,
    filter: (entry) => !relative(dependency, entry).split(sep).includes(".bin"),
  });
  copied.push(dependency);
}
for (const name of ["product.json", "LICENSE.txt", "ThirdPartyNotices.txt"]) {
  await cp(join(source, name), join(output, name));
}
await writeFile(
  join(output, "package.json"),
  JSON.stringify(
    {
      name: "synara-code-oss-runtime",
      private: true,
      type: "module",
      version: manifest.version,
    },
    null,
    2,
  ) + "\n",
);
// Publish the manifest LAST: a partial build must never be mistaken for a usable runtime.
await writeFile(join(output, "synara-runtime.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `Native Code-OSS resources staged at ${output}; no application or installer was created.`,
);

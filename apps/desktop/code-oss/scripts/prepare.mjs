/** Apply a narrow, pinned overlay to an existing Code-OSS source checkout. No download, installer, or release channel. */
import { readFile, writeFile, cp, mkdir } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { synaraDesktopIdentity } from "../../../../packages/shared/src/desktopIdentity.ts";

const integration = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(integration, "../../..");
const source = resolve(process.argv[2] ?? "");
if (!process.argv[2] || source === root || source === integration)
  throw new Error("Pass an isolated microsoft/vscode source checkout.");
const pin = JSON.parse(await readFile(join(integration, "upstream.json"), "utf8"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim();
if (commit !== pin.commit)
  throw new Error("The Code-OSS checkout must match the pinned commit exactly.");
const flavor = process.argv[3] ?? "production";
if (!["production", "beta", "canary", "cua", "development"].includes(flavor))
  throw new Error("Unknown Synara desktop flavor.");
const identity = synaraDesktopIdentity(flavor);
const packageJson = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
if (packageJson.name !== "code-oss-dev" || packageJson.version !== pin.version)
  throw new Error("Unexpected Code-OSS source version.");
const desktop = JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8"));
const electronPin = JSON.parse(await readFile(join(integration, "electron.json"), "utf8"));
if (desktop.dependencies.electron !== electronPin.version)
  throw new Error(
    "Review and update the Electron checksum pin when changing Synara's Electron version.",
  );
const checksumResponse = await fetch(
  `https://github.com/electron/electron/releases/download/v${electronPin.version}/SHASUMS256.txt`,
  { signal: AbortSignal.timeout(30_000) },
);
if (!checksumResponse.ok)
  throw new Error(`Electron checksum download failed: ${checksumResponse.status}`);
const electronChecksums = Buffer.from(await checksumResponse.arrayBuffer());
if (createHash("sha256").update(electronChecksums).digest("hex") !== electronPin.checksumsSha256)
  throw new Error("Electron release checksum manifest does not match the reviewed pin.");
const patches = JSON.parse(await readFile(join(integration, "patches.json"), "utf8"));
// Validate every source before writing any of them. A new upstream version requires review.
const changed = [];
for (const patch of patches) {
  const original = await readFile(join(source, patch.path), "utf8");
  if (createHash("sha256").update(original).digest("hex") !== patch.sha256)
    throw new Error(`Upstream source changed: ${patch.path}`);
  let text = original;
  for (const edit of patch.edits) {
    if (text.split(edit.before).length !== 2)
      throw new Error(`Patch anchor is not unique: ${patch.path}`);
    text = text.replace(edit.before, edit.after);
  }
  changed.push([patch.path, text]);
}
for (const [path, text] of changed) await writeFile(join(source, path), text);
await cp(join(integration, "overlay"), source, { recursive: true });
await mkdir(join(source, "src/vs/synara/common"), { recursive: true });
await cp(
  join(root, "packages/contracts/src/desktopIde.ts"),
  join(source, "src/vs/synara/common/desktopIde.ts"),
);
const product = JSON.parse(await readFile(join(source, "product.json"), "utf8"));
// Synara, not Microsoft's branded distribution. The existing Synara shell owns updates and identity.
for (const key of [
  "defaultChatAgent",
  "defaultChatProvider",
  "updateUrl",
  "quality",
  "extensionsGallery",
  "aiConfig",
  "copilot",
  "configurationSync",
  "tunnelApplicationConfig",
  "aiKey",
  "ariaKey",
  "statsUrl",
  "crashReporter",
  "tasConfig",
])
  delete product[key];
Object.assign(product, {
  nameShort: identity.displayName,
  nameLong: identity.displayName,
  applicationName: identity.userDataDirectoryName,
  dataFolderName: identity.defaultHomeDirectoryName,
  sharedDataFolderName: identity.defaultHomeDirectoryName,
  urlProtocol: identity.scheme,
  enableTelemetry: false,
  enableCrashReporter: false,
  extensionsGallery: {
    serviceUrl: "https://open-vsx.org/vscode/gallery",
    itemUrl: "https://open-vsx.org/vscode/item",
    resourceUrlTemplate: "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
  },
});
// Avoid resetting the host's OS identity. Synara's native main configures these.
for (const key of [
  "win32AppUserModelId",
  "darwinBundleIdentifier",
  "win32RegValueName",
  "win32TunnelServiceMutex",
  "serverApplicationName",
  "serverDataFolderName",
])
  delete product[key];
await writeFile(join(source, "product.json"), JSON.stringify(product, null, "\t") + "\n");
// Compile native dependencies for the Electron binary already shipped by Synara.
await writeFile(join(source, "build/checksums/electron.txt"), electronChecksums);
const npmrc = await readFile(join(source, ".npmrc"), "utf8");
await writeFile(
  join(source, ".npmrc"),
  npmrc.replace(/^target="[^"]+"/m, `target="${desktop.dependencies.electron}"`),
);
await writeFile(
  join(source, "synara-runtime.json"),
  JSON.stringify(
    {
      protocol: 1,
      ...pin,
      flavor,
      electron: desktop.dependencies.electron,
      platform: process.platform,
      arch: process.arch,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Prepared Microsoft Code-OSS ${pin.version} (${pin.commit}) for the existing Synara application.`,
);

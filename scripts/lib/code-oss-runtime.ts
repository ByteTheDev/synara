import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { SynaraPackagedDesktopFlavor } from "@synara/shared/desktopIdentity";

/** Refuse stale, partial, wrong-channel or cross-architecture native resources. */
export function validateCodeOssRuntime(path: string, expected: {
  commit: string; electron: string; platform: "mac" | "win" | "linux";
  arch: string; flavor: SynaraPackagedDesktopFlavor;
}): void {
  const manifest = JSON.parse(readFileSync(join(path, "synara-runtime.json"), "utf8")) as Record<string, unknown>;
  const platform = expected.platform === "mac" ? "darwin" : expected.platform === "win" ? "win32" : "linux";
  if (manifest.protocol !== 1 || manifest.commit !== expected.commit || manifest.electron !== expected.electron ||
    manifest.platform !== platform || manifest.arch !== expected.arch || manifest.flavor !== expected.flavor) {
    throw new Error("The prepared Code-OSS runtime does not match this desktop artifact.");
  }
  for (const entry of ["out/synara.js", "out/vs/workbench/workbench.desktop.main.js", "out/vs/workbench/workbench.desktop.main.css",
    "out/vs/workbench/api/node/extensionHostProcess.js", "out/vs/platform/terminal/node/ptyHostMain.js", "extensions/git/package.json", "extensions/typescript-language-features/package.json"]) {
    if (!existsSync(join(path, entry))) throw new Error(`Missing native Code-OSS resource: ${entry}`);
  }
}

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCodeOssRuntime } from "./code-oss-runtime";

const expected = {
  commit: "a".repeat(40),
  electron: "43.4.1",
  platform: "linux" as const,
  arch: "x64",
  flavor: "production" as const,
};
const directories: string[] = [];
function fixture(overrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "synara-code-oss-test-"));
  directories.push(root);
  writeFileSync(
    join(root, "synara-runtime.json"),
    JSON.stringify({ protocol: 1, ...expected, ...overrides }),
  );
  for (const file of [
    "out/synara.js",
    "out/vs/workbench/workbench.desktop.main.js",
    "out/vs/workbench/workbench.desktop.main.css",
    "out/vs/workbench/api/node/extensionHostProcess.js",
    "out/vs/platform/terminal/node/ptyHostMain.js",
    "extensions/git/package.json",
    "extensions/typescript-language-features/package.json",
  ]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "");
  }
  return root;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe("single-product native resource packaging", () => {
  it("accepts a matching, complete runtime", () => {
    expect(() => validateCodeOssRuntime(fixture(), expected)).not.toThrow();
  });
  it("rejects wrong channel, platform, ABI, architecture, revision and protocol", () => {
    for (const mismatch of [
      { flavor: "beta" },
      { platform: "darwin" },
      { arch: "arm64" },
      { electron: "99.0.0" },
      { commit: "b".repeat(40) },
      { protocol: 2 },
    ]) {
      expect(() => validateCodeOssRuntime(fixture(mismatch), expected)).toThrow("does not match");
    }
  });
  it("rejects partially built resources", () => {
    const root = fixture();
    rmSync(join(root, "out/synara.js"));
    expect(() => validateCodeOssRuntime(root, expected)).toThrow(
      "Missing native Code-OSS resource",
    );
  });
});

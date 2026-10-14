import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateCodeOssRuntime, withCodeOssResources } from "./code-oss-runtime";

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
    "node_modules.asar/vscode-oniguruma/release/onig.wasm",
    "node_modules.asar/@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm",
    "node_modules.asar.unpacked/vscode-oniguruma/release/onig.wasm",
    "node_modules.asar.unpacked/@vscode/tree-sitter-wasm/wasm/tree-sitter.wasm",
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

describe("native resource staging preserves installer configuration", () => {
  const native = { from: "/stage/code-oss", to: "code-oss", filter: ["**/*"] };
  it("adds native resources when no extra resources are configured", () => {
    expect(withCodeOssResources({ appId: "synara" }, native.from)).toEqual({
      appId: "synara",
      extraResources: [native],
    });
  });
  it("preserves a single string or file-set entry", () => {
    for (const existing of ["assets/**", { from: "assets", to: "assets" }]) {
      expect(
        withCodeOssResources({ extraResources: existing }, native.from).extraResources,
      ).toEqual([existing, native]);
    }
  });
  it("retains existing resource order without mutating the original configuration", () => {
    const entries = ["assets/**", { from: "helper", to: "helper" }];
    const original = { appId: "synara", extraResources: entries };
    const result = withCodeOssResources(original, native.from);
    expect(result.extraResources).toEqual([...entries, native]);
    expect(original.extraResources).toBe(entries);
    expect(entries).toHaveLength(2);
    expect(result).not.toBe(original);
  });
});

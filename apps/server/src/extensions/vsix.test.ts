import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { installVsix } from "./vsix";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
export function fixtureVsix(
  files: { name: string; contents: string; mode?: number; corruptCrc?: boolean }[],
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const contents = Buffer.from(file.contents);
    const checksum = (crc32(contents) + (file.corruptCrc ? 1 : 0)) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(contents.length, 18);
    header.writeUInt32LE(contents.length, 22);
    header.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(contents.length, 20);
    directory.writeUInt32LE(contents.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, contents);
    central.push(directory, name);
    offset += header.length + name.length + contents.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
const manifest = {
  publisher: "example",
  name: "formatter",
  version: "1.0.0",
  engines: { vscode: "^1.80.0" },
  main: "index.js",
};
const files = [
  { name: "extension/package.json", contents: JSON.stringify(manifest) },
  {
    name: "extension/index.js",
    contents: "throw new Error('Installer must not execute extension code');",
  },
];
async function root() {
  const value = await mkdtemp(path.join(os.tmpdir(), "synara-vsix-"));
  roots.push(value);
  return value;
}

describe("validated VSIX extraction", () => {
  it("installs real ZIP bytes without executing the package and preserves executable tools", async () => {
    const directory = await root();
    const result = await installVsix(
      fixtureVsix([
        ...files,
        { name: "extension/bin/tool", contents: "#!/bin/sh\nexit 0\n", mode: 0o100755 },
      ]),
      directory,
    );
    expect(result.id).toBe("example.formatter");
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(path.join(directory, result.directory, "index.js"), "utf8")).toContain(
      "must not execute",
    );
    expect((await readdir(directory)).some((name) => name.startsWith(".install-"))).toBe(false);
    if (process.platform !== "win32")
      expect((await stat(path.join(directory, result.directory, "bin/tool"))).mode & 0o777).toBe(
        0o700,
      );
  });
  it.each([
    { name: "../outside", contents: "escape" },
    { name: "extension/link", contents: "../../outside", mode: 0o120777 },
    { name: "extension/corrupted", contents: "corrupt", corruptCrc: true },
    { name: "extension/CON", contents: "device" },
    { name: "extension/package.json", contents: JSON.stringify(manifest) },
  ])("rejects unsafe or corrupt entry $name and cleans staging", async (extra) => {
    const directory = await root();
    await expect(installVsix(fixtureVsix([...files, extra]), directory)).rejects.toThrow();
    expect(await readdir(directory)).toEqual([]);
  });
  it("rejects registry/VSIX identity mismatches without retaining the package", async () => {
    const directory = await root();
    await expect(
      installVsix(fixtureVsix(files), directory, { id: "other.extension", version: "1.0.0" }),
    ).rejects.toThrow("identity differs");
    expect(await readdir(directory)).toEqual([]);
  });
  it("honors cancellation before extraction", async () => {
    const directory = await root();
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      installVsix(fixtureVsix(files), directory, undefined, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(await readdir(directory)).toEqual([]);
  });
});

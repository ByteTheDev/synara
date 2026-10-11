import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { arch, platform, release } from "node:os";
import { fileURLToPath } from "node:url";

const source = process.cwd();
const driver = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(process.env.RUNNER_TEMP, "review-dependencies");
const sourceSha = "f73074c7a4e4145a8944292e2103964cdf83ecb8";
const treeSha = "2d425cb0a78f67efaba133a7f15fba4342c9c6d5";
const run = (file, args, cwd = source) => execFileSync(file, args, { cwd, encoding: "utf8", timeout: 600_000 }).trim();
const git = (...args) => run("git", args);
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function guard() {
  assert.equal(platform(), "linux");
  assert.equal(arch(), "x64");
  assert.equal(git("rev-parse", "HEAD"), sourceSha);
  assert.equal(git("rev-parse", "HEAD^{tree}"), treeSha);
  assert.equal(git("diff", "--name-only", "HEAD", "--"), "");
  assert.equal(run("git", ["rev-parse", "HEAD"], driver), process.env.GITHUB_SHA);
  assert.equal(run("git", ["diff", "--name-only", "HEAD", "--"], driver), "");
}

guard();
mkdirSync(output, { recursive: true });
const roots = ["node_modules", "scripts/node_modules"];
for (const parent of ["apps", "packages"]) {
  for (const child of readdirSync(join(source, parent))) {
    const candidate = `${parent}/${child}/node_modules`;
    if (existsSync(join(source, candidate))) roots.push(candidate);
  }
}
assert.ok(roots.every((path) => existsSync(join(source, path))));
const archive = join(output, "node_modules.tar.gz");
// Keep Bun's relative workspace links intact; never dereference into source or host paths.
run("tar", ["-czf", archive, "--", ...roots]);
const bunSource = run("which", ["bun"]);
const bunVersion = run(bunSource, ["--version"]);
const expectedBun = JSON.parse(readFileSync("package.json", "utf8")).packageManager.replace(/^bun@/, "");
assert.equal(bunVersion, expectedBun);
copyFileSync(bunSource, join(output, "bun"));
guard();
const files = ["node_modules.tar.gz", "bun"].map((path) => ({
  path,
  bytes: statSync(join(output, path)).size,
  sha256: digest(join(output, path)),
}));
// The review connector downloads at most 512 MiB per artifact. Split the exact
// archive bytes; reconstruction must match its recorded whole-file SHA256.
const chunkSize = 384 * 1024 * 1024;
const parts = [];
const descriptor = openSync(archive, "r");
try {
  let offset = 0;
  while (offset < statSync(archive).size) {
    assert.ok(parts.length < 4, "Archive exceeded the bounded four-part upload");
    const length = Math.min(chunkSize, statSync(archive).size - offset);
    const bytes = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      const read = readSync(descriptor, bytes, filled, length - filled, offset + filled);
      assert.ok(read > 0, "Archive ended before its recorded size");
      filled += read;
    }
    const path = `dependencies.part-${parts.length}`;
    writeFileSync(join(output, path), bytes);
    parts.push({ path, bytes: length, sha256: createHash("sha256").update(bytes).digest("hex") });
    offset += length;
  }
} finally {
  closeSync(descriptor);
}
assert.ok(process.env.GITHUB_OUTPUT);
writeFileSync(process.env.GITHUB_OUTPUT, `parts=${parts.length}\n`, { flag: "a" });
const receipt = {
  sourceSha,
  treeSha,
  driverSha: process.env.GITHUB_SHA,
  run: process.env.GITHUB_RUN_ID,
  platform: platform(),
  architecture: arch(),
  release: release(),
  nodeVersion: process.version,
  bunVersion,
  packageJsonSha256: digest("package.json"),
  lockSha256: digest("bun.lock"),
  setupActionSha256: digest(".github/actions/setup-workspace/action.yml"),
  scriptSha256: digest(fileURLToPath(import.meta.url)),
  roots,
  files,
  parts,
  qualification: "Frozen-lockfile dependency installation only. No tests, build, native desktop, or live provider verification claimed. Electron runtime was not downloaded. Validate archive paths, links, hashes and local runtime compatibility before using this artifact.",
};
writeFileSync(join(output, "provenance.json"), JSON.stringify(receipt, null, 2) + "\n");
console.log(JSON.stringify(receipt));

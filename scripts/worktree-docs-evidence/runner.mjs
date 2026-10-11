import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const targets = {
  before: {
    head: "52f06318fdb3c0b4b310a8d55d0083cba0bde1a0",
    tree: "a4159d11d36ade68727a11503a3912d973bad66f",
  },
  after: {
    head: "a1b087d984a39cf9df936d5da9465db9e7679600",
    tree: "6011b0c1b9d93e2dcbf9b78b79c981d587cf4a4b",
  },
};
const side = process.env.DOCS_EVIDENCE_SIDE;
assert.ok(side === "before" || side === "after");
const target = targets[side];
assert.equal(process.env.DOCS_SOURCE_SHA, target.head);
assert.equal(process.env.DOCS_SOURCE_TREE, target.tree);
const root = process.cwd();
const driver = join(root, ".pr-driver");
const scripts = join(driver, "scripts/worktree-docs-evidence");
const output = resolve(process.env.DOCS_EVIDENCE_OUTPUT);
const liveReport = resolve(process.env.DOCS_LIVE_REPORT);
assert.equal(output, join(root, "worktree-docs-evidence"));
assert.ok(liveReport.startsWith(resolve(process.env.RUNNER_TEMP) + "/"));
mkdirSync(output, { recursive: true });
mkdirSync(resolve(liveReport, ".."), { recursive: true });
const digest = (data, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
const blob = (data) => digest(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]), "sha1");
const save = (name, data) =>
  writeFileSync(join(output, name), JSON.stringify(data, null, 2) + "\n");
const overlays = [
  {
    source: "capture.spec.ts",
    target: "apps/marketing/tests/pr1847-docs-evidence/capture.spec.ts",
  },
  { source: "playwright.config.ts", target: "apps/marketing/pr1847-docs-evidence.config.ts" },
];
const driverPaths = [
  ".github/workflows/worktree-docs-evidence.yml",
  "scripts/worktree-docs-evidence/capture.spec.ts",
  "scripts/worktree-docs-evidence/playwright.config.ts",
  "scripts/worktree-docs-evidence/runner.mjs",
  "scripts/worktree-docs-evidence/README.md",
];
function git(args, cwd = root) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(r.error, undefined);
  assert.equal(r.signal, null);
  assert.equal(r.status, 0, JSON.stringify({ args, status: r.status, stderr: r.stderr }));
  return r.stdout.trim();
}
function sourceGuard() {
  assert.equal(git(["rev-parse", "HEAD"]), target.head);
  assert.equal(git(["rev-parse", "HEAD^{tree}"]), target.tree);
  assert.equal(git(["diff", "--exit-code", "HEAD", "--"]), "");
  assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
  const paths = [
    "apps/marketing/content/docs/workflows/worktrees.mdx",
    "apps/marketing/content/docs/troubleshooting/git-and-worktrees.mdx",
    "apps/marketing/src/app/docs/[[...slug]]/page.tsx",
    "apps/marketing/next.config.ts",
    "apps/marketing/package.json",
    "bun.lock",
  ];
  return paths.map((path) => {
    const data = readFileSync(join(root, path));
    const sha = git(["rev-parse", `HEAD:${path}`]);
    assert.equal(blob(data), sha);
    return { path, gitBlob: sha, sha256: digest(data), bytes: data.length };
  });
}
function driverGuard() {
  const head = git(["rev-parse", "HEAD"], driver);
  assert.equal(head, process.env.GITHUB_SHA);
  assert.equal(git(["diff", "--exit-code", "HEAD", "--"], driver), "");
  const files = driverPaths.map((path) => {
    const data = readFileSync(join(driver, path));
    assert.equal(blob(data), git(["rev-parse", `HEAD:${path}`], driver));
    return { path, gitBlob: blob(data), sha256: digest(data), bytes: data.length };
  });
  return { head, tree: git(["rev-parse", "HEAD^{tree}"], driver), files };
}
if (process.argv[2] === "prepare") {
  save("initial-provenance.json", {
    side,
    target,
    run: process.env.GITHUB_RUN_ID,
    startedAt: new Date().toISOString(),
  });
  const sourceFiles = sourceGuard();
  const driverIdentity = driverGuard();
  for (const overlay of overlays) {
    assert.equal(existsSync(join(root, overlay.target)), false);
    mkdirSync(resolve(join(root, overlay.target), ".."), { recursive: true });
    const data = readFileSync(join(scripts, overlay.source));
    writeFileSync(join(root, overlay.target), data, { flag: "wx" });
    writeFileSync(join(output, overlay.source), data);
  }
  save("provenance.json", {
    side,
    target,
    sourceFiles,
    driver: driverIdentity,
    run: process.env.GITHUB_RUN_ID,
    preparedAt: new Date().toISOString(),
    node: process.version,
    qualification:
      "Production Next/Fumadocs source, actual light and reduced-motion preferences, deterministic VISUAL_TEST marketing data. Twelve total viewport images are documentation evidence; native GitCore behavior is a separate run.",
  });
} else if (process.argv[2] === "verify") {
  const errors = [];
  const attempt = (action) => {
    try {
      return action();
    } catch (error) {
      errors.push(String(error));
    }
  };
  attempt(() => driverGuard());
  for (const overlay of overlays)
    attempt(() => {
      const path = join(root, overlay.target);
      const expected = readFileSync(join(scripts, overlay.source));
      assert.equal(digest(readFileSync(path)), digest(expected));
      unlinkSync(path);
    });
  attempt(() => rmdirSync(join(root, "apps/marketing/tests/pr1847-docs-evidence")));
  const sourceFiles = attempt(() => sourceGuard());
  for (const phase of ["build", "test"])
    attempt(() => {
      const result = JSON.parse(readFileSync(join(output, `${phase}-exit.json`), "utf8"));
      assert.equal(result.process, 0, `${phase} actual exit was not successful`);
      assert.equal(result.tee, 0, `${phase} log writer failed`);
    });
  let stats;
  attempt(() => {
    const startedAt = new Date().toISOString();
    const before = statSync(liveReport);
    assert.ok(before.isFile() && before.size <= 10 * 1024 * 1024);
    const bytes = readFileSync(liveReport);
    assert.ok(bytes.length <= 10 * 1024 * 1024);
    const after = statSync(liveReport);
    writeFileSync(join(output, "playwright.json"), bytes, { flag: "wx" });
    save("report-snapshot.json", {
      startedAt,
      completedAt: new Date().toISOString(),
      bytes: bytes.length,
      sha256: digest(bytes),
      changedWhileReading: before.size !== after.size || before.mtimeMs !== after.mtimeMs,
      qualification:
        "One retained byte snapshot; subsequent live report writes cannot change this artifact.",
    });
    assert.equal(before.size, bytes.length, "Report size changed before capture");
    assert.equal(after.size, before.size, "Report size changed during capture");
    assert.equal(after.mtimeMs, before.mtimeMs, "Report changed during capture");
    const report = JSON.parse(bytes.toString("utf8"));
    stats = report.stats;
    assert.equal(stats.expected, 6);
    assert.equal(stats.unexpected, 0);
    assert.equal(stats.flaky, 0);
    assert.equal(stats.skipped, 0);
    const tests = [];
    const collect = (suites) => {
      for (const suite of suites ?? []) {
        for (const spec of suite.specs ?? []) tests.push(...spec.tests);
        collect(suite.suites);
      }
    };
    collect(report.suites);
    assert.equal(tests.length, 6);
    assert.ok(
      tests.every((test) => test.results.length === 1 && test.results[0].status === "passed"),
    );
  });
  for (const viewport of [
    { name: "desktop", width: 1440, height: 1100 },
    { name: "mobile", width: 390, height: 844 },
  ]) {
    for (const phase of ["worktrees-context", "worktrees-policy", "troubleshooting"])
      attempt(() => {
        const name = `${viewport.name}-${phase}`;
        const bytes = readFileSync(join(output, `${name}.png`));
        assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        assert.equal(bytes.readUInt32BE(16), viewport.width);
        assert.equal(bytes.readUInt32BE(20), viewport.height);
        const observed = JSON.parse(readFileSync(join(output, `${name}.json`), "utf8"));
        assert.equal(observed.side, side);
        assert.equal(observed.source, target.head);
        assert.equal(observed.tree, target.tree);
        assert.equal(observed.containsLinkPolicy, side === "after");
      });
  }
  attempt(() => {
    const directory = process.env.DOCS_PLAYWRIGHT_OUTPUT;
    if (!directory || !existsSync(directory)) return;
    let total = 0;
    const copy = (source, destination) => {
      mkdirSync(destination, { recursive: true });
      for (const name of readdirSync(source)) {
        const from = join(source, name),
          to = join(destination, name),
          stat = lstatSync(from);
        assert.equal(stat.isSymbolicLink(), false);
        if (stat.isDirectory()) copy(from, to);
        else {
          assert.ok(stat.isFile());
          total += stat.size;
          assert.ok(total <= 100 * 1024 * 1024);
          copyFileSync(from, to);
        }
      }
    };
    copy(directory, join(output, "playwright-output"));
  });
  save("verification.json", {
    side,
    target,
    sourceFiles,
    stats,
    errors,
    passed: errors.length === 0,
    verifiedAt: new Date().toISOString(),
  });
  const manifest = [];
  const walk = (directory, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        relative = prefix + name,
        stat = lstatSync(path);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) walk(path, relative + "/");
      else if (relative !== "manifest.json") {
        const data = readFileSync(path);
        manifest.push({
          path: relative,
          bytes: data.length,
          sha256: digest(data),
          gitBlob: blob(data),
        });
      }
    }
  };
  walk(output);
  save("manifest.json", manifest);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
} else throw new Error("Expected prepare or verify");

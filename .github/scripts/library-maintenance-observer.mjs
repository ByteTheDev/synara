import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const source = "3270dcf89bb60745ac568803a940cd7e7ac676a7";
const sourceTree = "3041a3cf0328b6e7e4d9b6c5027a2a1a09e33822";
const root = resolve(process.env.GITHUB_WORKSPACE, "source");
const driver = resolve(process.env.GITHUB_WORKSPACE, "driver");
const out = join(process.env.RUNNER_TEMP, "library-maintenance-evidence");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
};
function guard() {
  assert.equal(git(root, "rev-parse", "HEAD"), source);
  assert.equal(git(root, "rev-parse", "HEAD^{tree}"), sourceTree);
  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.equal(git(driver, "rev-parse", "HEAD"), process.env.GITHUB_SHA);
  assert.equal(git(driver, "status", "--porcelain=v1", "--untracked-files=all"), "");
}
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const phase = process.argv[2];
guard();
if (phase === "prepare") {
  assert.equal(git(root, "--version"), "git version 2.55.0");
  assert.equal(
    process.env.GIT_CONFIG_COUNT ?? "0",
    "0",
    "Unexpected inherited runtime Git configuration",
  );
  assert.ok(!existsSync(out));
  mkdirSync(out);
  const files = [
    "apps/server/src/projectAgent/library.test.ts",
    "apps/server/src/projectAgent/libraryGit.ts",
    "apps/server/src/projectAgent/libraryStore.ts",
    "apps/server/src/git/Layers/GitCore.ts",
    "apps/server/package.json",
    "bun.lock",
  ];
  save(join(out, "provenance.json"), {
    source,
    sourceTree,
    driver: process.env.GITHUB_SHA,
    driverTree: git(driver, "rev-parse", "HEAD^{tree}"),
    run: process.env.GITHUB_RUN_ID,
    gitVersion: git(root, "--version"),
    files: files.map((path) => ({
      path,
      gitBlob: git(root, "rev-parse", "HEAD:" + path),
      sha256: hash(readFileSync(join(root, path))),
    })),
    qualification:
      "Unchanged exact-main 25-case library Vitest file using real Git. Ten independent runs per mode; default runtime configuration versus only process-scoped maintenance.autoDetach=false. No production/test source edits, skipped assertion, retry conversion, repository/global config write, remote Git operation or cleanup success inference. Actual root status/signal/errors and all Trace2 bytes are retained. Descendant teardown on timeout is runner-owned and unproven.",
  });
} else if (phase === "run") {
  const mode = process.argv[3];
  assert.ok(["default", "foreground"].includes(mode));
  const dir = join(out, mode);
  assert.ok(!existsSync(dir));
  mkdirSync(dir);
  const attempts = [];
  for (let attempt = 1; attempt <= 10; attempt++) {
    const attemptDir = join(dir, String(attempt));
    mkdirSync(attemptDir);
    const log = join(attemptDir, "vitest.log");
    const reportPath = join(attemptDir, "vitest.json");
    const tracePath = join(attemptDir, "git-trace.jsonl");
    const env = { ...process.env, GIT_TRACE2_EVENT: tracePath };
    if (mode === "foreground") {
      assert.equal(env.GIT_CONFIG_COUNT ?? "0", "0");
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = "maintenance.autoDetach";
      env.GIT_CONFIG_VALUE_0 = "false";
    }
    const args = [
      "run",
      "test",
      "src/projectAgent/library.test.ts",
      "--reporter=json",
      "--outputFile=" + reportPath,
    ];
    const startedAt = new Date().toISOString();
    const fd = openSync(log, "wx");
    let result;
    try {
      result = spawnSync("bun", args, {
        cwd: join(root, "apps/server"),
        env,
        stdio: ["ignore", fd, fd],
        timeout: 90_000,
      });
    } finally {
      closeSync(fd);
    }
    const finishedAt = new Date().toISOString();
    let report = null;
    let reportError = null;
    try {
      const parsed = JSON.parse(readFileSync(reportPath, "utf8"));
      assert.equal(parsed.numTotalTests, 25);
      assert.equal(parsed.numPendingTests, 0);
      assert.equal(parsed.testResults.length, 1);
      report = {
        total: parsed.numTotalTests,
        passed: parsed.numPassedTests,
        failed: parsed.numFailedTests,
        assertions: parsed.testResults[0].assertionResults.map((entry) => ({
          name: entry.fullName,
          status: entry.status,
          failures: entry.failureMessages,
        })),
      };
    } catch (error) {
      reportError = String(error);
    }
    const observation = {
      mode,
      attempt,
      command: ["bun", ...args],
      startedAt,
      finishedAt,
      rootStatus: result.status,
      rootSignal: result.signal,
      processError: result.error ? String(result.error) : null,
      report,
      reportError,
      passed:
        result.status === 0 &&
        result.signal === null &&
        !result.error &&
        report?.passed === 25 &&
        report.failed === 0 &&
        reportError === null,
    };
    save(join(attemptDir, "result.json"), observation);
    attempts.push(observation);
    process.stdout.write(
      JSON.stringify({
        mode,
        attempt,
        status: observation.rootStatus,
        passed: observation.passed,
        reportError,
      }) + "\n",
    );
  }
  save(join(dir, "attempts.json"), attempts);
  guard();
  if (attempts.some((entry) => !entry.passed)) process.exitCode = 1;
} else if (phase === "verify") {
  const provenance = JSON.parse(readFileSync(join(out, "provenance.json"), "utf8"));
  for (const file of provenance.files)
    assert.equal(hash(readFileSync(join(root, file.path))), file.sha256, file.path);
  const modes = [];
  for (const mode of ["default", "foreground"]) {
    const attempts = JSON.parse(readFileSync(join(out, mode, "attempts.json"), "utf8"));
    assert.equal(attempts.length, 10);
    const traces = [];
    for (const attempt of attempts) {
      const tracePath = join(out, mode, String(attempt.attempt), "git-trace.jsonl");
      const bytes = readFileSync(tracePath);
      assert.ok(bytes.length > 0 && bytes.length < 50_000_000);
      const events = bytes
        .toString("utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      traces.push({
        attempt: attempt.attempt,
        events: events.length,
        maintenance: events.filter(
          (entry) => entry.event === "start" && entry.argv?.includes("maintenance"),
        ),
        detachment: events.filter(
          (entry) =>
            entry.event === "region_enter" &&
            entry.category === "maintenance" &&
            entry.label === "detach",
        ),
        repack: events.filter(
          (entry) => entry.event === "child_start" && entry.argv?.includes("repack"),
        ),
      });
    }
    save(join(out, mode, "trace-summary.json"), traces);
    modes.push({
      mode,
      attempts: attempts.length,
      passed: attempts.filter((entry) => entry.passed).length,
    });
  }
  save(join(out, "outcomes.json"), {
    modes,
    interpretation:
      "Default failures stay failed workflow steps. Foreground success alone does not establish the historical failure's cause; inspect the actual failure and Trace2 lifetimes before repairing source. No assertion or production behavior was changed.",
  });
  const files = walk(out)
    .filter((path) => path !== join(out, "files.json"))
    .map((path) => ({
      name: path.slice(out.length + 1),
      bytes: statSync(path).size,
      sha256: hash(readFileSync(path)),
    }));
  save(join(out, "files.json"), files);
  if (modes.some((entry) => entry.passed !== 10)) process.exitCode = 1;
} else throw new Error("Expected prepare, run or verify");

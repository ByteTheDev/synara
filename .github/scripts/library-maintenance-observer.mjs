import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const source = "99a1c00c46db38e557a29cb6c958692b0558d297";
const sourceTree = "41cb78248a829dd47a07ceacadcd0be9f044dde8";
const root = resolve(process.env.GITHUB_WORKSPACE, "source");
const driver = resolve(process.env.GITHUB_WORKSPACE, "driver");
const out = join(process.env.RUNNER_TEMP, "library-maintenance-evidence");
const live = join(process.env.RUNNER_TEMP, "library-maintenance-live");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const git = (cwd, ...args) => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
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
async function observeCommand(command, args, options) {
  const child = spawn(command, args, options);
  const startedAt = new Date().toISOString();
  let rootExit = null;
  let rootClose = null;
  let expired = false;
  let observationEndedBeforeClose = false;
  let termination = null;
  let deadline;
  let drainDeadline;
  const processErrors = [];
  child.once("exit", (code, signal) => {
    rootExit = { code, signal, at: new Date().toISOString() };
  });
  const result = await new Promise((resolveResult) => {
    let finished = false;
    const finish = (observerExitCode) => {
      if (!finished) {
        finished = true;
        resolveResult({ observerExitCode });
      }
    };
    child.once("error", (error) => {
      processErrors.push({
        message: String(error),
        at: new Date().toISOString(),
        afterDeadline: expired,
      });
      // A failed owned-handle kill must leave the bounded drain armed.
      if (!expired) finish(127);
    });
    child.once("close", (code, signal) => {
      rootClose = { code, signal, at: new Date().toISOString() };
      finish(expired ? 124 : (code ?? 1));
    });
    deadline = setTimeout(() => {
      expired = true;
      termination = {
        mechanism: "owned ChildProcess handle only",
        rootExitAtDeadline: rootExit,
        handleKillReturned: null,
      };
      try {
        if (rootExit === null) termination.handleKillReturned = child.kill("SIGKILL");
      } catch (error) {
        termination.error = String(error);
      }
      drainDeadline = setTimeout(() => {
        observationEndedBeforeClose = true;
        child.unref();
        finish(124);
      }, 10_000);
    }, 90_000);
  });
  clearTimeout(deadline);
  clearTimeout(drainDeadline);
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    ...result,
    rootExit,
    rootClose,
    processErrors,
    deadlineExceeded: expired,
    observationEndedBeforeClose,
    termination,
    descendantCleanup: "Not performed or proven by this observer; left to the hosted runner.",
  };
}
function freezeObservation(input, output) {
  const capture = {
    input,
    output,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    initialSize: null,
    observedSizeAfterRead: null,
    capturedBytes: 0,
    capped: false,
    shortRead: false,
    error: null,
    tailMayContinue: true,
    qualification:
      "Immutable byte-prefix snapshot of a separate live file. Capture is bounded by its observed initial size and 50 MB. A detached descendant can still append to the live file; this snapshot does not prove its final tail or lifetime.",
  };
  let fd;
  try {
    fd = openSync(input, "r");
    const initial = fstatSync(fd);
    assert.ok(initial.isFile());
    capture.initialSize = initial.size;
    const limit = Math.min(initial.size, 50_000_000);
    capture.capped = initial.size > limit;
    const buffer = Buffer.alloc(limit);
    while (capture.capturedBytes < limit) {
      const read = readSync(
        fd,
        buffer,
        capture.capturedBytes,
        limit - capture.capturedBytes,
        capture.capturedBytes,
      );
      if (read === 0) break;
      capture.capturedBytes += read;
    }
    capture.shortRead = capture.capturedBytes !== limit;
    capture.observedSizeAfterRead = fstatSync(fd).size;
    const bytes = buffer.subarray(0, capture.capturedBytes);
    // No subprocess receives a path or file descriptor within the evidence tree.
    writeFileSync(output, bytes, { flag: "wx", mode: 0o444 });
    capture.sha256 = hash(bytes);
  } catch (error) {
    capture.error = String(error);
  } finally {
    if (fd !== undefined) closeSync(fd);
    capture.finishedAt = new Date().toISOString();
  }
  return capture;
}
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
  assert.ok(!existsSync(live));
  mkdirSync(out);
  mkdirSync(live);
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
      "Unchanged exact-main 25-case library Vitest file using real Git. Ten independent runs per mode; default runtime configuration versus only process-scoped maintenance.autoDetach=false. No production/test source edits, skipped assertion, retry conversion, repository/global config write, remote Git operation or cleanup success inference. Actual root exit/close/signal/errors are separate from the 90-second observer deadline and bounded 10-second drain. Logs, reports and Trace2 are frozen bounded byte-prefix snapshots from separate live paths, with capture times, observed sizes and possible missing tails explicit. Descendant teardown on timeout is runner-owned and unproven.",
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
    const liveDir = join(live, mode, String(attempt));
    mkdirSync(liveDir, { recursive: true });
    const log = join(liveDir, "vitest.log");
    const reportPath = join(liveDir, "vitest.json");
    const tracePath = join(liveDir, "git-trace.jsonl");
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
    const fd = openSync(log, "wx");
    let pending;
    try {
      pending = observeCommand("bun", args, {
        cwd: join(root, "apps/server"),
        env,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      // The parent closes its descriptor immediately after spawn; descendants
      // may keep their live-file descriptors after the observed root exits.
      closeSync(fd);
    }
    const result = await pending;
    const snapshots = ["vitest.log", "vitest.json", "git-trace.jsonl"].map((name) => ({
      name,
      ...freezeObservation(join(liveDir, name), join(attemptDir, name)),
    }));
    let report = null;
    let reportError = null;
    try {
      const parsed = JSON.parse(readFileSync(join(attemptDir, "vitest.json"), "utf8"));
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
      ...result,
      snapshots,
      report,
      reportError,
      passed:
        result.observerExitCode === 0 &&
        result.rootExit?.code === 0 &&
        result.rootExit.signal === null &&
        result.rootClose?.code === 0 &&
        result.processErrors.length === 0 &&
        !result.deadlineExceeded &&
        !result.observationEndedBeforeClose &&
        snapshots.every((entry) => !entry.error && !entry.capped && !entry.shortRead) &&
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
        rootExit: observation.rootExit,
        observerExitCode: observation.observerExitCode,
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
  const evidenceErrors = [];
  for (const mode of ["default", "foreground"]) {
    let attempts = [];
    const traces = [];
    try {
      attempts = JSON.parse(readFileSync(join(out, mode, "attempts.json"), "utf8"));
      assert.equal(attempts.length, 10);
      for (const attempt of attempts) {
        try {
          for (const snapshot of attempt.snapshots) {
            assert.equal(snapshot.error, null, snapshot.name);
            assert.equal(snapshot.capped, false, snapshot.name);
            assert.equal(snapshot.shortRead, false, snapshot.name);
            const retained = readFileSync(join(out, mode, String(attempt.attempt), snapshot.name));
            assert.equal(retained.length, snapshot.capturedBytes, snapshot.name);
            assert.equal(hash(retained), snapshot.sha256, snapshot.name);
          }
          const tracePath = join(out, mode, String(attempt.attempt), "git-trace.jsonl");
          const bytes = readFileSync(tracePath);
          assert.ok(bytes.length > 0 && bytes.length <= 50_000_000);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          const lines = text.split("\n");
          const incompleteTrailingRecord = lines.at(-1) !== "";
          if (!incompleteTrailingRecord) lines.pop();
          const parseErrors = [];
          const events = [];
          for (const [index, line] of lines.entries()) {
            try {
              events.push(JSON.parse(line));
            } catch (error) {
              parseErrors.push({ line: index + 1, message: String(error) });
            }
          }
          if (parseErrors.length > 0 || incompleteTrailingRecord)
            evidenceErrors.push({
              mode,
              attempt: attempt.attempt,
              parseErrors,
              incompleteTrailingRecord,
            });
          traces.push({
            attempt: attempt.attempt,
            events: events.length,
            parseErrors,
            incompleteTrailingRecord,
            qualification:
              "Summary of retained byte-prefix snapshot only; live Trace2 tail can continue.",
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
        } catch (error) {
          evidenceErrors.push({ mode, attempt: attempt.attempt, message: String(error) });
        }
      }
    } catch (error) {
      evidenceErrors.push({ mode, message: String(error) });
    }
    mkdirSync(join(out, mode), { recursive: true });
    save(join(out, mode, "trace-summary.json"), traces);
    modes.push({
      mode,
      attempts: attempts.length,
      passed: attempts.filter((entry) => entry.passed).length,
    });
  }
  save(join(out, "outcomes.json"), {
    modes,
    evidenceErrors,
    interpretation:
      "Default failures stay failed workflow steps. Foreground success alone does not establish the historical failure's cause; inspect the actual failure and the bounded Trace2 snapshots before repairing source. Missing/capped/partial snapshots remain explicit evidence failures; raw incomplete records are retained. Captures cannot prove the final lifetime of detached maintenance. No assertion or production behavior was changed.",
  });
  const files = walk(out)
    .filter((path) => path !== join(out, "files.json"))
    .map((path) => ({
      name: path.slice(out.length + 1),
      bytes: statSync(path).size,
      sha256: hash(readFileSync(path)),
    }));
  save(join(out, "files.json"), files);
  if (modes.some((entry) => entry.passed !== 10) || evidenceErrors.length > 0) process.exitCode = 1;
} else throw new Error("Expected prepare, run or verify");

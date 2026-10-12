import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const target = process.env.CONTROL_TARGET;
if (target !== "before" && target !== "after") throw new Error("Unknown control target");
const SOURCE = target === "before" ? "3a0375ae1dde80597002ec79d9ada39820815daa" : "1de9fa2de0db98ca7966e00fc45f53df0fdd1b6d";
const TREE = target === "before" ? "c332250a419bae846762ad99de3f22efe407560c" : "e3b9a5aa4b3b7bba9c77f8379f4768f13556d1d6";
const SELECTED = /refuses a trailing-space fallback replaced|keeps an over-cap trailing-space/u;
const TEST = "apps/server/src/git/Layers/GitCore.test.ts";
const TEST_SHA256 = "45e90c82ef22d8978483b194f363e1f17758523e3bd2a9d3b172171cdd4e6042";
const EXPECTED = new Map([
  ["apps/server/src/git/Layers/GitCore.ts", target === "before" ? "879f6ad7e08177ca1f977d81d4f0acf9e009d5ca" : "013c404ddb9c13620093d4ecf30a8ec773ec38c0"],
  [TEST, "3c19fb6244d34ca5a4dc2b63efa585e337e4a970"],
  ["packages/shared/src/filesystemPlatform.ts", "8177805509291307814a721f0fc3fab9f69a037b"],
  ["apps/marketing/content/docs/workflows/worktrees.mdx", "4ce7108bdb099272b9037b309b4d4acefbf54109"],
  ["apps/marketing/content/docs/troubleshooting/git-and-worktrees.mdx", "c4a6cdef035ade671c26a63c6d03e03b4457dd5d"],
]);
const root = process.cwd();
const driver = path.join(root, ".pr-driver");
const output = path.join(root, "gitcore-snapshot-control-evidence");
const liveReport = path.join(root, "gitcore-snapshot-control-live", "results.json");
mkdirSync(output, { recursive: true });
mkdirSync(path.dirname(liveReport), { recursive: true });
const hash = (data, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
const blob = (data) => hash(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]), "sha1");
const writeJson = (name, value) => writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);

function command(executable, args, cwd = root, allowMissing = false) {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8", timeout: 30_000 });
  const record = {
    executable,
    args,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? String(result.error) : null,
  };
  if (!allowMissing && result.status !== 0) throw new Error(JSON.stringify(record));
  return record;
}

function guardSource() {
  const head = command("git", ["rev-parse", "HEAD"]).stdout.trim();
  const tree = command("git", ["rev-parse", "HEAD^{tree}"]).stdout.trim();
  if (head !== SOURCE || tree !== TREE) throw new Error(`Unexpected source ${head}/${tree}`);
  command("git", ["diff", "--exit-code", "HEAD", "--"]);
  const trackedStatus = command("git", ["status", "--porcelain", "--untracked-files=no"]);
  if (trackedStatus.stdout.trim()) {
    const bounded = (record) => ({
      ...record,
      stdout: record.stdout.slice(0, 40_000),
      stderr: record.stderr.slice(0, 40_000),
      stdoutTruncated: record.stdout.length > 40_000,
      stderrTruncated: record.stderr.length > 40_000,
    });
    // Read-only startup diagnostics. The original failure remains a failure;
    // neither Git configuration nor the index/working tree is repaired here.
    writeJson("tracked-status-failure.json", {
      observedAt: new Date().toISOString(),
      head,
      tree,
      trackedStatus: bounded(trackedStatus),
      rawDiff: bounded(command("git", ["diff", "--raw", "HEAD", "--"], root, true)),
      applicationLineEndings: bounded(command("git", ["ls-files", "--eol", "--", ...EXPECTED.keys()], root, true)),
      gitConfig: ["core.autocrlf", "core.eol", "core.filemode"].map((key) =>
        bounded(command("git", ["config", "--get", key], root, true))),
      applicationBytes: [...EXPECTED].map(([relative, expectedBlob]) => {
        const data = readFileSync(path.join(root, relative));
        return { path: relative, expectedBlob, actualBlob: blob(data), sha256: hash(data), bytes: data.length };
      }),
      qualification: "Bounded read-only observations from a rejected tracked-source guard. Consult the command and test receipts to determine whether test execution started.",
    });
    throw new Error("Tracked source is not clean");
  }
  const files = [];
  for (const [relative, expectedBlob] of EXPECTED) {
    const data = readFileSync(path.join(root, relative));
    const identity = { path: relative, bytes: data.length, gitBlob: blob(data), sha256: hash(data) };
    if (identity.gitBlob !== expectedBlob) throw new Error(`Unexpected application bytes: ${relative}`);
    if (relative === TEST && identity.sha256 !== TEST_SHA256) throw new Error("Canonical test SHA256 changed");
    files.push(identity);
  }
  return { head, tree, files, trackedSourceClean: true };
}

function guardDriver() {
  const expected = process.env.DRIVER_SHA;
  if (!expected || !/^[a-f0-9]{40}$/u.test(expected)) throw new Error("Missing exact driver SHA");
  const head = command("git", ["rev-parse", "HEAD"], driver).stdout.trim();
  if (head !== expected) throw new Error("Wrong driver checkout");
  command("git", ["diff", "--exit-code", "HEAD", "--"], driver);
  return {
    head,
    tree: command("git", ["rev-parse", "HEAD^{tree}"], driver).stdout.trim(),
    files: [
      ".github/workflows/gitcore-snapshot-control.yml",
      "scripts/gitcore-native-evidence/snapshot-control.mjs",
      ".github/workflows/gitcore-native-evidence.yml",
      "scripts/gitcore-native-evidence/runner.mjs",
      "scripts/gitcore-native-evidence/README.md",
      "scripts/gitcore-native-evidence/format-proposal.mjs",
    ].map((relative) => {
      const data = readFileSync(path.join(driver, relative));
      return { path: relative, bytes: data.length, gitBlob: blob(data), sha256: hash(data) };
    }),
  };
}

async function runTests() {
  const args = [
    "run", "test", "src/git/Layers/GitCore.test.ts",
    "-t", SELECTED.source,
    "--reporter=default", "--reporter=json",
    `--outputFile=${liveReport}`,
  ];
  writeJson("command.json", { executable: "bun", args, cwd: "apps/server", timeoutMs: 1_200_000 });
  writeFileSync(path.join(output, "vitest.log"), "");
  return await new Promise((resolve) => {
    let finished = false;
    let deadlineTimer;
    let drainTimer;
    let drainDue = Infinity;
    const observed = {
      rootExit: null,
      close: null,
      processErrors: [],
      deadlineReachedAt: null,
      outputCutoff: null,
      signalAttempts: [],
    };
    const child = spawn("bun", args, {
      cwd: path.join(root, "apps/server"),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = (data, stream) => {
      if (finished) return;
      appendFileSync(path.join(output, "vitest.log"), data);
      stream.write(data);
    };
    const onStdout = (data) => record(data, process.stdout);
    const onStderr = (data) => record(data, process.stderr);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    const signalOwnedChild = (signal) => {
      // This is the ChildProcess created above, never a later numerical PID.
      if (observed.rootExit !== null) return;
      try {
        observed.signalAttempts.push({ signal, sent: child.kill(signal), error: null });
      } catch (error) {
        observed.signalAttempts.push({ signal, sent: false, error: String(error) });
      }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      clearTimeout(drainTimer);
      // Stop all file writes before hashing/finalizing the log. A late close or
      // error cannot change the immutable observation returned to the caller.
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      if (observed.close === null) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      const result = JSON.parse(JSON.stringify(observed));
      writeJson("exit.json", result);
      resolve(result);
    };
    const boundDrain = (reason, durationMs) => {
      const due = performance.now() + durationMs;
      if (due >= drainDue) return;
      drainDue = due;
      clearTimeout(drainTimer);
      drainTimer = setTimeout(() => {
        if (finished) return;
        observed.outputCutoff = {
          reason,
          at: new Date().toISOString(),
          stdoutEnded: child.stdout.readableEnded,
          stderrEnded: child.stderr.readableEnded,
        };
        signalOwnedChild("SIGKILL");
        finish();
      }, durationMs);
    };
    child.on("exit", (code, signal) => {
      if (finished) return;
      observed.rootExit = { code, signal, at: new Date().toISOString() };
      boundDrain("root exited but inherited output pipes did not close", 5_000);
    });
    child.on("error", (error) => {
      if (finished) return;
      observed.processErrors.push(String(error));
      // Preserve the real exit if one arrives; do not invent an exit code.
      boundDrain("process error without completed output drain", 5_000);
    });
    child.on("close", (code, signal) => {
      if (finished) return;
      observed.close = { code, signal, at: new Date().toISOString() };
      finish();
    });
    deadlineTimer = setTimeout(() => {
      if (finished) return;
      observed.deadlineReachedAt = new Date().toISOString();
      signalOwnedChild("SIGTERM");
      boundDrain("test deadline reached without completed output drain", 10_000);
    }, 1_200_000);
  });
}

const errors = [];
let exit = null;
const receipt = {
  source: SOURCE,
  tree: TREE,
  totalCases: 151,
  expectedSelectedCases: 3,
  expectedUnselectedCases: 148,
  target,
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runnerOs: process.env.RUNNER_OS ?? null,
  node: process.version,
  qualification: "Three unchanged descriptor-refusal cases selected from an identical complete 151-case fixture. Before is the rejected unbounded-copy proposal, never a published feature head. Actual failures remain failures; 148 cases are explicitly unselected. Full native qualification is a separate workflow.",
};

try {
  receipt.before = guardSource();
  receipt.driver = guardDriver();
  if (existsSync(liveReport)) throw new Error("Unexpected pre-existing live test report");
  receipt.environment = {
    bun: command("bun", ["--version"]),
    git: command("git", ["--version"]),
    // Read only. No global or environment overrides normalize the test repos.
    autocrlf: command("git", ["config", "--show-origin", "--get-all", "core.autocrlf"], root, true),
    symlinks: command("git", ["config", "--show-origin", "--get-all", "core.symlinks"], root, true),
    attributes: hash(readFileSync(path.join(root, ".gitattributes"))),
    lock: hash(readFileSync(path.join(root, "bun.lock"))),
    package: hash(readFileSync(path.join(root, "package.json"))),
    serverPackage: hash(readFileSync(path.join(root, "apps/server/package.json"))),
    setupAction: hash(readFileSync(path.join(root, ".github/actions/setup-workspace/action.yml"))),
    testConfig: hash(readFileSync(path.join(root, "apps/server/vitest.config.ts"))),
  };
  writeJson("provenance.json", receipt);
  exit = await runTests();
  receipt.after = guardSource();
  guardDriver();
  if (exit.rootExit?.code !== 0 || exit.rootExit?.signal || exit.close === null ||
      exit.processErrors.length || exit.deadlineReachedAt || exit.outputCutoff) {
    errors.push(`Actual test process observation ${JSON.stringify(exit)}`);
  }
  if (!existsSync(liveReport)) throw new Error("Missing actual Vitest JSON report");
  const capturedAt = new Date().toISOString();
  const reportBytes = readFileSync(liveReport);
  // Only this snapshot is retained. A surviving descendant cannot write into
  // the uploaded evidence directory after its observed process/output cutoff.
  writeFileSync(path.join(output, "results.json"), reportBytes);
  receipt.reportSnapshot = {
    source: "gitcore-snapshot-control-live/results.json",
    capturedAt,
    completedAt: new Date().toISOString(),
    bytes: reportBytes.length,
    sha256: hash(reportBytes),
    rootExit: exit.rootExit,
    closeObserved: exit.close !== null,
    outputCutoff: exit.outputCutoff,
    qualification: "Single observed byte snapshot; missing or partial JSON and every cutoff remain failures.",
  };
  const report = JSON.parse(reportBytes.toString("utf8"));
  receipt.results = {
    success: report.success,
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    todo: report.numTodoTests,
    assertions: report.testResults.flatMap((suite) => suite.assertionResults.map((test) => ({
      name: test.fullName,
      status: test.status,
      failureMessages: test.failureMessages,
    }))),
  };
  const selected = receipt.results.assertions.filter((test) => SELECTED.test(test.name));
  const unselected = receipt.results.assertions.filter((test) => !SELECTED.test(test.name));
  receipt.results.selected = selected;
  receipt.results.unselected = unselected.length;
  if (report.success !== true || report.numTotalTests !== 151 || report.numPassedTests !== 3 ||
      report.numFailedTests !== 0 || report.numPendingTests !== 148 || report.numTodoTests !== 0 ||
      selected.length !== 3 || selected.some((test) => test.status !== "passed") ||
      unselected.length !== 148 || unselected.some((test) => !["pending", "skipped"].includes(test.status))) {
    errors.push("The three unchanged refusal controls did not fully pass");
  }
} catch (error) {
  errors.push(error.stack ?? String(error));
} finally {
  receipt.finishedAt = new Date().toISOString();
  receipt.exit = exit;
  receipt.errors = errors;
  writeJson("provenance.json", receipt);
  const artifacts = readdirSync(output).sort().filter((name) => name !== "verified.json").map((name) => {
    const data = readFileSync(path.join(output, name));
    return { name, bytes: data.length, sha256: hash(data) };
  });
  writeJson("verified.json", { source: SOURCE, tree: TREE, driver: process.env.DRIVER_SHA ?? null, errors, artifacts });
  if (errors.length) console.error(errors.join("\n"));
  const actualCode = exit?.rootExit?.code;
  process.exitCode = actualCode && actualCode > 0 ? actualCode : errors.length ? 1 : 0;
}

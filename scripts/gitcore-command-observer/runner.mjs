import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, lstatSync, openSync, fstatSync, readSync, closeSync } from "node:fs";
import path from "node:path";

const SOURCE = "7ff5f383c482b5b9dfadce509394932a6d0d9d71";
const TREE = "7553d4535af517433ad6f74e471afae6c326d22e";
const TEST = "apps/server/src/git/Layers/GitCore.test.ts";
const TEST_SHA256 = "e196d0d2f60a0f68ed2934edb0ca06e69ec8cc73b6a182e5135836a9acfcaeca";
const EXPECTED = new Map([
  ["apps/server/src/git/Layers/GitCore.ts", "21c2c2e2c6fe3a766d9a17bfa6f920f486c81da9"],
  [TEST, "c300ce2e6fcc39a4c7ccce93c7a379de975a7d66"],
  ["packages/shared/src/filesystemPlatform.ts", "8177805509291307814a721f0fc3fab9f69a037b"],
  ["apps/marketing/content/docs/workflows/worktrees.mdx", "4ce7108bdb099272b9037b309b4d4acefbf54109"],
  ["apps/marketing/content/docs/troubleshooting/git-and-worktrees.mdx", "c4a6cdef035ade671c26a63c6d03e03b4457dd5d"],
]);
const root = process.cwd();
const driver = path.join(root, ".pr-driver");
const output = path.join(root, "gitcore-command-observer-evidence");
const liveReport = path.join(root, "gitcore-command-observer-live", "results.json");
const observedTest = "apps/server/src/git/Layers/GitCore.command-observer.test.ts";
const selectedNames = [
  "returns UI status before its background upstream refresh completes",
  "commits and pushes a large diff, then skips when up to date",
];
if (existsSync(output) || existsSync(path.dirname(liveReport)) || existsSync(path.join(root, observedTest))) {
  throw new Error("Refuse existing observation paths");
}
mkdirSync(output);
mkdirSync(path.dirname(liveReport));
const hash = (data, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
const blob = (data) => hash(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]), "sha1");
const writeJson = (name, value) => writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`);

function stableRead(file, maximumBytes) {
  const first = lstatSync(file);
  if (!first.isFile() || first.isSymbolicLink() || first.size > maximumBytes) throw new Error("Invalid or oversized live file");
  const fd = openSync(file, "r");
  try {
    const before = fstatSync(fd);
    if (before.dev !== first.dev || before.ino !== first.ino || before.size !== first.size) throw new Error("Live file changed before read");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("Live file truncated during read");
      offset += count;
    }
    const after = fstatSync(fd);
    const named = lstatSync(file);
    for (const stat of [after, named]) {
      if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino ||
          stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs) {
        throw new Error("Live file changed during read");
      }
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function prepareObservation() {
  const specification = JSON.parse(readFileSync(path.join(driver, "scripts/gitcore-command-observer/overlay.json"), "utf8"));
  const canonical = readFileSync(path.join(root, TEST));
  if (hash(canonical) !== TEST_SHA256 || blob(canonical) !== specification.canonicalBlob) throw new Error("Canonical fixture identity mismatch");
  let observed = canonical.toString("utf8");
  for (const edit of specification.replacements) {
    if (observed.split(edit.before).length !== 2) throw new Error("Observation anchor count changed");
    observed = observed.replace(edit.before, edit.after);
  }
  let inverse = observed;
  for (const edit of specification.replacements.toReversed()) {
    if (inverse.split(edit.after).length !== 2) throw new Error("Observation inverse count changed");
    inverse = inverse.replace(edit.after, edit.before);
  }
  if (inverse !== canonical.toString("utf8") || blob(Buffer.from(observed)) !== specification.observedBlob) {
    throw new Error("Observed fixture or inverse mismatch");
  }
  writeFileSync(path.join(root, observedTest), observed, { flag: "wx" });
  return { canonical: { path: TEST, bytes: canonical.length, sha256: hash(canonical), blob: blob(canonical) },
    observed: { path: observedTest, bytes: Buffer.byteLength(observed), sha256: hash(Buffer.from(observed)), blob: blob(Buffer.from(observed)) },
    replacements: specification.replacements.length, reversalExact: true };
}

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
      ".github/workflows/gitcore-command-observer.yml",
      "scripts/gitcore-command-observer/runner.mjs",
      "scripts/gitcore-command-observer/overlay.json",
      "scripts/gitcore-command-observer/README.md",
    ].map((relative) => {
      const data = readFileSync(path.join(driver, relative));
      const expectedBlob = command("git", ["rev-parse", "HEAD:" + relative], driver).stdout.trim();
      if (blob(data) !== expectedBlob) throw new Error("Driver bytes changed: " + relative);
      return { path: relative, bytes: data.length, gitBlob: blob(data), sha256: hash(data) };
    }),
  };
}

async function runTests() {
  const args = [
    "run", "test", "src/git/Layers/GitCore.command-observer.test.ts",
    "--testNamePattern=" + selectedNames.join("|"),
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
  canonicalCases: 146,
  selectedCases: 2,
  unselectedCases: 144,
  startedAt: new Date().toISOString(),
  platform: process.platform,
  arch: process.arch,
  runnerOs: process.env.RUNNER_OS ?? null,
  node: process.version,
  qualification: "Diagnostic-only delegated command and temporary-scope observations around two unchanged canonical cases. The complete 146-case fixture is copied and reversibly observed; 144 cases are explicitly unselected. Original assertions, 500 ms limit, fetch gate and cleanup remain. This is not a full-suite pass or an historical-interleaving claim.",
};

try {
  receipt.before = guardSource();
  receipt.driver = guardDriver();
  receipt.overlay = prepareObservation();
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
  const actualObserved = readFileSync(path.join(root, observedTest));
  if (blob(actualObserved) !== receipt.overlay.observed.blob || hash(actualObserved) !== receipt.overlay.observed.sha256) {
    throw new Error("Observed fixture changed during execution");
  }
  if (exit.rootExit?.code !== 0 || exit.rootExit?.signal || exit.close === null ||
      exit.processErrors.length || exit.deadlineReachedAt || exit.outputCutoff) {
    errors.push(`Actual test process observation ${JSON.stringify(exit)}`);
  }
  if (!existsSync(liveReport)) throw new Error("Missing actual Vitest JSON report");
  const capturedAt = new Date().toISOString();
  const reportBytes = stableRead(liveReport, 8 * 1024 * 1024);
  // Only this snapshot is retained. A surviving descendant cannot write into
  // the uploaded evidence directory after its observed process/output cutoff.
  writeFileSync(path.join(output, "results.json"), reportBytes);
  receipt.reportSnapshot = {
    source: "gitcore-command-observer-live/results.json",
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
  const selected = receipt.results.assertions.filter((test) => selectedNames.some((name) => test.name.endsWith(name)));
  const unselected = receipt.results.assertions.filter((test) => !selected.includes(test));
  if (report.numTotalTests !== 146 || report.numPassedTests + report.numFailedTests !== 2 ||
      report.numPendingTests !== 144 || report.numTodoTests !== 0 ||
      receipt.results.assertions.length !== 146 || selected.length !== 2 ||
      selectedNames.some((name) => selected.filter((test) => test.name.endsWith(name)).length !== 1) ||
      selected.some((test) => !["passed", "failed"].includes(test.status)) ||
      unselected.length !== 144 || unselected.some((test) => !["pending", "skipped"].includes(test.status))) {
    errors.push("The diagnostic did not execute exactly the original two cases");
  }
  if (report.success !== true || report.numFailedTests !== 0 || selected.some((test) => test.status !== "passed")) {
    errors.push("An original selected assertion failed; preserve its actual nonzero outcome");
  }
  const retainedLog = stableRead(path.join(output, "vitest.log"), 8 * 1024 * 1024).toString("utf8");
  const prefix = "SYNARA_GIT_COMMAND_OBSERVATIONS ";
  const traces = retainedLog.split(/\r?\n/u).filter((line) => line.includes(prefix));
  if (traces.length !== 1) throw new Error("Expected one complete observation trace");
  const trace = JSON.parse(traces[0].slice(traces[0].indexOf(prefix) + prefix.length).replace(/\u001b\[[0-9;]*m/gu, ""));
  if (!Array.isArray(trace.events) || trace.events.length > 4096 || trace.dropped !== 0 ||
      !Array.isArray(trace.activeAtEnd)) throw new Error("Incomplete observation trace");
  writeJson("observations.json", trace);
  receipt.observation = { events: trace.events.length, dropped: trace.dropped, activeAtEnd: trace.activeAtEnd };
  console.log(prefix + JSON.stringify(trace));
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

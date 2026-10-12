import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readlinkSync, readSync, readdirSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeCommand } from "./owned-command-observer.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const driverRoot = path.resolve(directory, "../..");
const pins = JSON.parse(readFileSync(path.join(directory, "pins.json"), "utf8"));
const now = () => new Date().toISOString();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlob = (bytes) =>
  createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
const recordError = (error) => ({
  name: error.name, code: error.code ?? null, message: error.message,
});
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], {
  timeout: 10_000, maxBuffer: 8 * 1024 * 1024,
});
const driverRelative = ".runtime-startup-budget-driver";
const driverPaths = [
  ".github/workflows/pr1804-native-budget.yml",
  "scripts/pr1804-native-budget/README.md",
  "scripts/pr1804-native-budget/pins.json",
  "scripts/pr1804-native-budget/runner.mjs",
  "scripts/pr1804-native-budget/owned-command-observer.mjs",
  "scripts/pr1804-native-budget/extract.py",
  "scripts/pr1804-native-budget/test-overlay.json",
  "scripts/pr1804-native-budget/NativeStartupProbe.ts",
];
function metadata(relative, bytes) {
  return { path: relative, bytes: bytes.length, sha256: digest(bytes), gitBlob: gitBlob(bytes) };
}
function safeRelative(relative) {
  assert(relative && !path.isAbsolute(relative));
  assert(relative.split(/[\\/]/).every((part) =>
    part && part !== "." && part !== ".." && !part.startsWith(".")));
  return relative;
}
function verifyDriver() {
  assert.equal(git(driverRoot, "rev-parse", "HEAD").toString().trim(), process.env.GITHUB_SHA);
  git(driverRoot, "diff", "--exit-code", "HEAD", "--");
  return driverPaths.map((relative) => {
    const file = path.join(driverRoot, relative);
    assert(lstatSync(file).isFile(), "Driver path must remain regular: " + relative);
    const bytes = readFileSync(file);
    assert(bytes.equals(git(driverRoot, "show", "HEAD:" + relative)),
      "Driver bytes changed: " + relative);
    return metadata(relative, bytes);
  });
}
function sourceProof(root, pin, overlays, created, stage) {
  assert.equal(git(root, "rev-parse", "HEAD").toString().trim(), pin.sha);
  assert.equal(git(root, "rev-parse", "HEAD^{tree}").toString().trim(), pin.tree);
  const listing = git(root, "ls-tree", "-r", "-z", "HEAD");
  let count = 0;
  for (const row of listing.toString().split("\0").filter(Boolean)) {
    const match = /^(\d{6}) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(row);
    assert(match, "Unexpected tracked entry: " + row.slice(0, 120));
    const [, mode, originalSha, relative] = match;
    assert(!path.isAbsolute(relative) && !relative.split("/").includes(".."));
    const file = path.join(root, relative);
    const stat = lstatSync(file);
    let bytes;
    if (mode === "120000") {
      assert(stat.isSymbolicLink(), "Expected source symlink: " + relative);
      bytes = Buffer.from(readlinkSync(file));
    } else {
      assert(mode === "100644" || mode === "100755");
      assert(stat.isFile(), "Expected regular source file: " + relative);
      if (process.platform !== "win32")
        assert.equal(Boolean(stat.mode & 0o111), mode === "100755", relative);
      bytes = readFileSync(file);
    }
    assert.equal(gitBlob(bytes), overlays.get(relative)?.gitBlob ?? originalSha, relative);
    count++;
  }
  assert.equal(count, pin.files);
  const differences = git(root, "diff", "--name-only", "HEAD", "--")
    .toString().trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(differences, [...overlays.keys()].sort());
  for (const [relative, receipt] of created) {
    const file = path.join(root, relative);
    assert(lstatSync(file).isFile());
    const bytes = readFileSync(file);
    assert.equal(bytes.length, receipt.bytes, relative);
    assert.equal(gitBlob(bytes), receipt.gitBlob, relative);
  }
  const status = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    .toString().split("\0").filter(Boolean);
  for (const entry of status) {
    const code = entry.slice(0, 2);
    const relative = entry.slice(3);
    if (overlays.has(relative))
      assert.equal(code, " M", "Only the declared unstaged test overlay is allowed.");
    else {
      assert.equal(code, "??", "Unexpected tracked status: " + entry);
      assert(created.has(relative) || relative === driverRelative + "/" ||
        relative.startsWith(driverRelative + "/"), "Unexpected untracked source: " + entry);
    }
  }
  for (const entry of pin.productionFiles) {
    const bytes = readFileSync(path.join(root, entry.path));
    assert.equal(gitBlob(bytes), overlays.get(entry.path)?.gitBlob ?? entry.sha, entry.path);
  }
  return {
    stage, at: now(), head: pin.sha, tree: pin.tree, trackedFiles: count,
    listingSha256: digest(listing), rawTrackedBytesVerified: true,
    posixExecutableModesVerified: process.platform !== "win32", status,
    overlays: [...overlays.values()].map(({ original, ...receipt }) => receipt),
    addedFixtures: [...created.values()],
    qualification: "Every tracked byte/HEAD/tree and staged/unstaged difference checked. Only the declared native test/probe and separately verified driver checkout may appear in Git status. Windows raw bytes and Git modes are verified, not POSIX executable permission semantics; ignored dependency caches are not source claims.",
  };
}
function walkFiles(root, prefix = "") {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)).flatMap((entry) => {
    assert(!entry.name.startsWith("."), "Hidden evidence is refused.");
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    assert(!entry.isSymbolicLink(), "Evidence symlink is refused: " + relative);
    if (entry.isDirectory()) return walkFiles(path.join(root, entry.name), relative);
    assert(entry.isFile(), "Only regular evidence is admitted: " + relative);
    return [relative];
  });
}
function snapshotFile(source, destination, relative, capBytes) {
  const captureStartedAt = now();
  const failedAdmission = (error, extra = {}) => ({
    path: relative, captureStartedAt, captureCompletedAt: now(),
    missing: false, possibleTail: true, snapshotAdmissionFailed: true,
    error: recordError(error), ...extra,
  });
  const sameFileState = (left, right) => left.isFile() && right.isFile() &&
    left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
  const identity = (stat) => ({
    device: String(stat.dev), inode: String(stat.ino), mode: String(stat.mode),
    bytes: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs),
  });
  let admitted;
  try {
    assert(Number.isSafeInteger(capBytes) && capBytes > 0);
    admitted = lstatSync(source, { bigint: true });
    assert(admitted.isFile(), "Only a regular diagnostic output path can be admitted.");
  } catch (error) {
    if (error.code === "ENOENT")
      return { path: relative, missing: true, captureStartedAt, captureCompletedAt: now() };
    return failedAdmission(error);
  }
  let fd;
  try {
    // The nonblocking flag also bounds a regular-file-to-FIFO replacement before open.
    fd = openSync(source, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (error) {
    return failedAdmission(error, { admittedPath: identity(admitted) });
  }
  let receipt;
  let bytes;
  try {
    const before = fstatSync(fd, { bigint: true });
    let openedPath;
    try {
      openedPath = lstatSync(source, { bigint: true });
      assert(sameFileState(admitted, before) && sameFileState(openedPath, before),
        "Diagnostic output path or descriptor changed during admission.");
    } catch (error) {
      return failedAdmission(error, {
        admittedPath: identity(admitted), openedDescriptor: identity(before),
        openedPath: openedPath ? identity(openedPath) : null,
      });
    }
    const length = Number(before.size < BigInt(capBytes) ? before.size : BigInt(capBytes));
    bytes = Buffer.alloc(length);
    let used = 0;
    while (used < length) {
      const amount = readSync(fd, bytes, used, length - used, used);
      if (amount === 0) break;
      used += amount;
    }
    bytes = bytes.subarray(0, used);
    const after = fstatSync(fd, { bigint: true });
    let endPath = null;
    let endPathError = null;
    try { endPath = lstatSync(source, { bigint: true }); }
    catch (error) { endPathError = recordError(error); }
    const capped = before.size > BigInt(capBytes) || after.size > BigInt(capBytes);
    const changedDuringCapture = !sameFileState(before, after) ||
      endPath === null || !sameFileState(after, endPath) || !sameFileState(admitted, endPath);
    receipt = {
      ...metadata(relative, bytes), captureStartedAt, captureCompletedAt: now(),
      observedInitialBytes: Number(before.size), observedEndBytes: Number(after.size),
      admittedPath: identity(admitted), openedPath: identity(openedPath),
      capturedDescriptor: identity(after), endPath: endPath ? identity(endPath) : null,
      endPathError, capBytes, capped, changedDuringCapture, shortRead: bytes.length !== length,
      possibleTail: capped || changedDuringCapture || bytes.length !== length,
      qualification: "One fixed byte prefix from an admitted regular-file descriptor, with nonblocking no-follow open and matching pathname/descriptor identity, size and timestamps checked before and after capture. Later live writes are not uploaded or included in the manifest; root exit and pipe close do not prove all descendants have exited.",
    };
  } finally {
    closeSync(fd);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o444 });
  return receipt;
}

function completeRoot(result) {
  assert(result, "No actual command result");
  assert.equal(result.actualRootExitObserved, true);
  assert.equal(result.actualRootExit, 0);
  assert.equal(result.actualRootSignal, null);
  assert.equal(result.closeObserved, true);
  assert.equal(result.closeCode, 0);
  assert.equal(result.closeSignal, null);
  assert.equal(result.deadline, false);
  assert.equal(result.capped, false);
  assert.equal(result.forcedOutputCutoff, false);
  assert.deepEqual(result.processErrors, []);
  assert.deepEqual(result.outputErrors, []);
  assert.equal(result.observerStatus, 0);
}
function reportAccounting(report, suite) {
  assert(Array.isArray(report.testResults) && report.testResults.length === 1);
  assert.equal(path.resolve(report.testResults[0].name), path.resolve(suite));
  return {
    success: report.success, total: report.numTotalTests, passed: report.numPassedTests,
    failed: report.numFailedTests, pending: report.numPendingTests, todo: report.numTodoTests,
    assertions: report.testResults[0].assertionResults.map((entry) => ({
      title: entry.title, fullName: entry.fullName, status: entry.status,
      duration: entry.duration, failureMessages: entry.failureMessages ?? [],
    })),
  };
}
function verifyDatabase(accounting, result) {
  completeRoot(result);
  assert.equal(accounting.success, true);
  assert.equal(accounting.total, pins.databaseCount);
  assert.equal(accounting.passed, pins.databaseCount);
  assert.equal(accounting.failed, 0);
  assert.equal(accounting.pending, 0);
  assert.equal(accounting.todo, 0);
  assert.equal(accounting.assertions.length, pins.databaseCount);
  assert.deepEqual(accounting.assertions.map((entry) => entry.title).sort(),
    [...pins.databaseNames].sort());
  assert(accounting.assertions.every((entry) => entry.status === "passed"));
}
function verifyNative(accounting, result) {
  completeRoot(result);
  assert.equal(accounting.success, true);
  assert.equal(accounting.total, pins.originalTestCount + pins.nativeTestCount);
  assert.equal(accounting.passed, pins.nativeTestCount);
  assert.equal(accounting.failed, 0);
  assert.equal(accounting.pending, pins.originalTestCount);
  assert.equal(accounting.todo, 0);
  const selected = accounting.assertions.filter((entry) =>
    entry.fullName.includes(pins.nativeTestName));
  const unselected = accounting.assertions.filter((entry) =>
    !entry.fullName.includes(pins.nativeTestName));
  assert.equal(selected.length, pins.nativeTestCount);
  assert.deepEqual(selected.map((entry) => entry.title).sort(), [...pins.nativeNames].sort());
  assert(selected.every((entry) => entry.status === "passed"),
    "All three unchanged native predicates must pass, including the first cold case.");
  assert.equal(unselected.length, pins.originalTestCount);
  assert(unselected.every((entry) => ["pending", "skipped"].includes(entry.status)));
}
function summarizeScenario(scenario, events) {
  const starts = new Map();
  const spans = [];
  const dispatches = [];
  const settlements = [];
  for (const event of events) {
    assert.equal(typeof event.kind, "string");
    assert(Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0);
    if (event.kind === "phase-start") {
      assert(!starts.has(event.id), "Duplicate real phase ID");
      starts.set(event.id, event);
    } else if (event.kind === "phase-end") {
      const start = starts.get(event.id);
      assert(start && start.phase === event.phase, "No matching real phase admission");
      assert(Number.isFinite(event.durationMs) && event.durationMs >= 0);
      starts.delete(event.id);
      spans.push({
        phase: event.phase, startScenario: start.scenario, endScenario: event.scenario,
        startedMs: start.elapsedMs, completedMs: event.elapsedMs,
        durationMs: event.durationMs, exit: event.exit,
      });
    } else if (event.kind === "engine-dispatch-admitted") {
      const prior = events.filter((row) => row.kind === "dispatch-start" &&
        row.elapsedMs <= event.elapsedMs).at(-1);
      assert(prior, "Actual dispatch admission needs its preceding call observation");
      dispatches.push({
        eventSequence: event.eventSequence, scenario: event.scenario,
        calledMs: prior.elapsedMs, admittedMs: event.elapsedMs,
        admissionObservedMs: event.elapsedMs - prior.elapsedMs,
      });
    } else if (event.kind === "durable-delivery-observed") {
      const dispatch = dispatches.find((row) => row.eventSequence === event.delivery.eventSequence);
      assert(dispatch, "Persisted delivery must belong to an actual dispatched event");
      settlements.push({
        scenario: event.scenario, observedMs: event.elapsedMs,
        dispatchToSettlementObservationMs: event.elapsedMs - dispatch.calledMs,
        actualPersistedDelivery: event.delivery,
      });
    }
  }
  return {
    scenario, events: events.length, spans, incompleteSpans: [...starts.values()],
    dispatches, settlements,
    scopeClose: events.filter((row) => row.kind.startsWith("production-scope-close-")),
    warmPool: events.filter((row) => ["warm-pool-observation", "warm-reuse-observation"].includes(row.kind)),
    leaseTimeout: events.filter((row) => row.kind === "lease-timeout-observed"),
    ownedExit: events.filter((row) => row.kind === "owned-exit-summary"),
    qualification: pins.qualification,
  };
}
function verifyScenario(scenario, events, summary) {
  assert.equal(summary.incompleteSpans.length, 0, "All observed production spans must settle.");
  const results = events.filter((row) => row.kind === "case-result");
  assert.equal(results.length, 1); assert.equal(results[0].passed, true);
  assert.equal(results[0].errorCount, 0);
  const qualifications = events.filter((row) => row.kind === "qualification");
  assert.equal(qualifications.length, 1);
  assert.equal(qualifications[0].teardownOverride, false);
  assert.equal(qualifications[0].preparationOverride, false);
  assert.equal(qualifications[0].managedPoolIdleTtlMs, 300_000);
  assert.equal(summary.ownedExit.length, 1);
  const exit = summary.ownedExit[0];
  assert.equal(exit.productionScopeSucceeded, true);
  assert(Array.isArray(exit.children) && exit.children.length > 0);
  assert(exit.children.every((child) => child.rawExit === "success" && Number.isInteger(child.code)));
  for (const child of exit.children) {
    const firstSignal = exit.signals.find((signal) => signal.rootPid === child.pid);
    assert(firstSignal && firstSignal.captureComplete === true && firstSignal.includeRootTree === true);
    const actualExits = events.filter((row) => row.kind === "native-root-exit" && row.pid === child.pid);
    assert.equal(actualExits.length, 1);
    assert.equal(actualExits[0].watcher, "success");
    assert.equal(actualExits[0].actualCode, child.code);
  }
  const closed = summary.scopeClose.filter((row) => row.kind === "production-scope-close-completed");
  assert.equal(closed.length, 1); assert.equal(closed[0].exit, "Success");
  assert(Number.isFinite(closed[0].durationMs) && closed[0].durationMs >= 0);
  const expectedDeliveries = scenario === "startup-cancellation" ? 0 : 2;
  assert.equal(summary.dispatches.length, expectedDeliveries);
  assert.equal(summary.settlements.length, expectedDeliveries);
  for (const row of summary.settlements) {
    const delivery = row.actualPersistedDelivery;
    assert.equal(delivery.consumerName, "provider-command-reactor.v1");
    assert.equal(delivery.state, "succeeded");
    assert(Number.isInteger(delivery.attemptCount) && delivery.attemptCount >= 1);
    assert(Number.isFinite(Date.parse(delivery.completedAt)));
    assert(Number.isFinite(Date.parse(delivery.updatedAt)));
    assert(Number.isFinite(row.dispatchToSettlementObservationMs) &&
      row.dispatchToSettlementObservationMs >= 0);
  }
  if (scenario === "cold-warm") {
    assert.equal(summary.warmPool.length, 2);
    assert(summary.warmPool.every((row) => row.children.length === 1 &&
      row.children[0].running === true && row.children[0].rawExit === "pending"));
    assert.equal(summary.warmPool[0].children[0].pid, summary.warmPool[1].children[0].pid);
    assert(summary.spans.some((row) => row.phase === "checkpoint.capture" && row.exit === "Success"));
    assert(summary.spans.some((row) => row.phase === "provider.runtime-stop" && row.exit === "Success"));
  } else if (scenario === "lease-contention") {
    assert.equal(summary.leaseTimeout.length, 1);
    assert.equal(summary.leaseTimeout[0].configuredLeaseMs, 30_000);
    assert(summary.leaseTimeout[0].elapsedMs >= 29_500);
    assert.equal(events.filter((row) => row.kind === "controlled-checkpoint-hold-start").length, 1);
    assert.equal(events.filter((row) => row.kind === "controlled-checkpoint-hold-ended").length, 1);
  } else {
    assert.equal(events.filter((row) => row.kind === "controlled-readiness-hold-entered").length, 1);
    assert.equal(events.filter((row) => row.kind === "controlled-readiness-hold-ended").length, 1);
    assert.equal(events.filter((row) => row.kind === "caller-cancellation-requested").length, 1);
    assert.equal(events.filter((row) => row.kind === "native-session-admitted").length, 0);
    assert.equal(events.filter((row) => row.kind === "before-native-prompt-write").length, 0);
  }
}

async function main() {
  const side = process.argv[2];
  const platform = process.argv[3];
  assert(["before", "after"].includes(side));
  assert(["linux-x64", "windows-x64"].includes(platform));
  assert.equal(process.arch, "x64");
  assert.equal(process.platform, pins.platforms[platform].os);
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_WORKSPACE && process.env.GITHUB_SHA);
  const sourceRoot = path.resolve(process.env.GITHUB_WORKSPACE);
  assert.equal(path.relative(sourceRoot, driverRoot), driverRelative);
  const pin = side === "before" ? pins.before : pins.candidate;
  const root = path.join(process.env.RUNNER_TEMP, "pr1804-native-budget-" + side + "-" + platform);
  const live = path.join(root, "live");
  const privateDirectory = path.join(root, "private");
  const nativeOutput = path.join(live, "native-observations");
  const frozen = path.join(root, "frozen");
  assert(!existsSync(root), "Refuse reused diagnostic output.");
  mkdirSync(nativeOutput, { recursive: true });
  mkdirSync(privateDirectory); mkdirSync(frozen);
  const failures = [], phases = [], snapshots = new Map();
  const overlays = new Map(), created = new Map();
  const writeJson = (relative, value) => {
    const file = path.join(frozen, safeRelative(relative));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o444 });
  };
  const attempt = (phaseName, callback) => {
    try { return callback(); }
    catch (error) { failures.push({ phase: phaseName, ...recordError(error) }); return null; }
  };
  const capture = (source, relative, cap = 32 * 1024 * 1024) => {
    safeRelative(relative);
    if (!snapshots.has(relative))
      snapshots.set(relative, snapshotFile(source, path.join(frozen, relative), relative, cap));
    const receipt = snapshots.get(relative);
    assert(!receipt.missing && !receipt.possibleTail, "Incomplete fixed snapshot: " + relative);
    return receipt;
  };
  const proof = (stage) => sourceProof(sourceRoot, pin, overlays, created, stage);
  const phase = async (name, command, cwd, deadlineMs, env = process.env) => {
    let result = null;
    try {
      writeJson("source-before-" + name + ".json", proof("before-" + name));
      result = await observeCommand({
        command, cwd, deadlineMs, drainMs: 10_000, capBytes: 32 * 1024 * 1024,
        logPath: path.join(live, name + ".log"),
        spawnChild: (name, args, options) => spawn(name, args, { ...options, env }),
      });
      writeJson(name + "-process.json", result);
    } catch (error) { failures.push({ phase: name, ...recordError(error) }); }
    finally {
      attempt(name + "-log-snapshot", () => capture(path.join(live, name + ".log"), name + ".log"));
      attempt(name + "-source", () => writeJson("source-after-" + name + ".json", proof("after-" + name)));
      phases.push({ name, result });
    }
    return result;
  };
  const copyOwned = (relative, bytes) => {
    safeRelative(relative);
    const file = path.join(sourceRoot, relative);
    assert(!existsSync(file), "Refuse replacing an existing diagnostic fixture.");
    writeFileSync(file, bytes, { flag: "wx" });
    created.set(relative, metadata(relative, bytes));
  };
  const report = (name, suite) => {
    capture(path.join(live, name + ".json"), name + ".json");
    const accounting = reportAccounting(JSON.parse(readFileSync(path.join(frozen, name + ".json"), "utf8")), suite);
    writeJson(name + "-test-accounting.json", accounting);
    return accounting;
  };
  const installOverlay = () => {
    const recipe = JSON.parse(readFileSync(path.join(directory, "test-overlay.json"), "utf8"));
    const original = readFileSync(path.join(sourceRoot, pins.testPath));
    assert.equal(original.length, pins.testBaselineBytes);
    assert.equal(gitBlob(original), pins.testBaselineBlob);
    assert.equal(digest(original), pins.testBaselineSha256);
    assert.equal(recipe.baselineBlob, pins.testBaselineBlob);
    assert.equal(recipe.baselineSha256, pins.testBaselineSha256);
    assert.equal(recipe.resultBlob, pins.testResultBlob);
    assert.equal(recipe.resultSha256, pins.testResultSha256);
    const lines = original.toString("utf8").match(/[^\n]*\n|[^\n]+$/g) ?? [];
    const removed = [];
    let previousEnd = 0;
    for (const edit of recipe.edits) {
      assert(Number.isInteger(edit.startLine) && Number.isInteger(edit.endLine));
      assert(edit.startLine >= previousEnd && edit.endLine >= edit.startLine && edit.endLine <= lines.length);
      assert.equal(typeof edit.replacement, "string");
      removed.push(lines.slice(edit.startLine, edit.endLine).join(""));
      previousEnd = edit.endLine;
    }
    let output = "", cursor = 0;
    const inverse = [];
    for (const [index, edit] of recipe.edits.entries()) {
      output += lines.slice(cursor, edit.startLine).join("");
      inverse.push({ offset: output.length, replacement: edit.replacement, original: removed[index] });
      output += edit.replacement;
      cursor = edit.endLine;
    }
    output += lines.slice(cursor).join("");
    let restored = output;
    for (const edit of inverse.toReversed()) {
      assert.equal(restored.slice(edit.offset, edit.offset + edit.replacement.length), edit.replacement);
      restored = restored.slice(0, edit.offset) + edit.original +
        restored.slice(edit.offset + edit.replacement.length);
    }
    assert(Buffer.from(restored).equals(original), "Every original source byte must reverse exactly.");
    const test = Buffer.from(output);
    assert.equal(test.length, pins.testResultBytes);
    assert.equal(gitBlob(test), pins.testResultBlob); assert.equal(digest(test), pins.testResultSha256);
    const probe = readFileSync(path.join(directory, "NativeStartupProbe.ts"));
    assert.equal(probe.length, pins.probeBytes);
    assert.equal(gitBlob(probe), pins.probeBlob); assert.equal(digest(probe), pins.probeSha256);
    copyOwned(pins.probeTarget, probe);
    overlays.set(pins.testPath, { ...metadata(pins.testPath, test), original });
    writeFileSync(path.join(sourceRoot, pins.testPath), test);
    writeFileSync(path.join(frozen, "ProviderCommandReactor.test.ts"), test, { flag: "wx", mode: 0o444 });
    writeFileSync(path.join(frozen, "NativeStartupProbe.ts"), probe, { flag: "wx", mode: 0o444 });
    writeFileSync(path.join(frozen, "test-overlay.json"), readFileSync(path.join(directory, "test-overlay.json")),
      { flag: "wx", mode: 0o444 });
    writeJson("overlay.json", {
      test: metadata(pins.testPath, test), baseline: metadata(pins.testPath, original),
      probe: metadata(pins.probeTarget, probe), edits: recipe.edits.length,
      originalBytesReversed: true, originalCanonicalCasesUnchanged: pins.originalTestCount,
      qualification: "Only opt-in harness wiring and the three original native measurement predicates are added. New durable-delivery/real-scope observations are additive. No production source or original assertion is edited.",
    });
  };
  const download = async () => {
    const nativePin = pins.platforms[platform];
    const url = new URL(nativePin.url);
    assert.equal(url.protocol, "https:"); assert.equal(url.hostname, "registry.npmjs.org");
    assert.equal(url.username, ""); assert.equal(url.password, ""); assert.equal(url.port, "");
    assert.equal(url.search, ""); assert.equal(url.hash, "");
    assert.equal(url.pathname, "/" + nativePin.name + "/-/cli-" + platform + "-" + pins.version + ".tgz");
    const archive = path.join(privateDirectory, "opencode.tgz");
    const fd = openSync(archive, "wx");
    const hashes = Object.fromEntries(["sha1", "sha256", "sha512"].map((name) => [name, createHash(name)]));
    const result = { url: nativePin.url, status: null, bytes: 0, contentLength: null, error: null };
    let response;
    try {
      response = await fetch(nativePin.url, { redirect: "error", signal: AbortSignal.timeout(300_000) });
      result.status = response.status; result.contentLength = response.headers.get("content-length");
      assert.equal(response.status, 200); assert.equal(Number(result.contentLength), nativePin.archiveBytes);
      assert(response.body);
      for await (const chunk of response.body) {
        result.bytes += chunk.length;
        assert(result.bytes <= nativePin.archiveBytes, "Archive exceeds exact official byte count.");
        for (const hash of Object.values(hashes)) hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const written = writeSync(fd, chunk, offset, chunk.length - offset);
          assert(written > 0); offset += written;
        }
      }
      assert.equal(result.bytes, nativePin.archiveBytes);
      result.sha1 = hashes.sha1.digest("hex");
      result.sha256 = hashes.sha256.digest("hex");
      result.sha512Base64 = hashes.sha512.digest("base64");
      assert.equal(result.sha1, nativePin.sha1); assert.equal(result.sha256, nativePin.sha256);
      assert.equal(result.sha512Base64, nativePin.sha512Base64);
      return archive;
    } catch (error) {
      result.error = recordError(error);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      throw error;
    } finally { closeSync(fd); writeJson("archive-integrity.json", result); }
  };
  const allowed = new Set(["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "LANG", "LC_ALL", "TERM", "CI"]);
  const nativeEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    allowed.has(name.toUpperCase())));
  const home = path.join(privateDirectory, "home"), temp = path.join(privateDirectory, "temp");
  mkdirSync(home); mkdirSync(temp);
  Object.assign(nativeEnvironment, { HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp });
  for (const [name, child] of Object.entries({
    XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", XDG_CACHE_HOME: "cache", XDG_STATE_HOME: "state",
    APPDATA: "appdata", LOCALAPPDATA: "localappdata",
  })) {
    nativeEnvironment[name] = path.join(home, child); mkdirSync(nativeEnvironment[name]);
  }
  let driverBefore = null, binary = null, binaryBefore = null;
  let databaseVerification = null, nativeVerification = null;
  const scenarioSummaries = [];
  const scenarios = ["cold-warm", "lease-contention", "startup-cancellation"];
  try {
    driverBefore = verifyDriver();
    assert.equal(gitBlob(readFileSync(path.join(directory, "extract.py"))), pins.extractorBlob);
    assert.equal(gitBlob(readFileSync(path.join(directory, "owned-command-observer.mjs"))), pins.observerBlob);
    assert.equal(JSON.parse(readFileSync(path.join(sourceRoot, "apps/server/package.json"), "utf8"))
      .dependencies["@opencode/client"], pins.version);
    writeJson("provenance.json", {
      schemaVersion: 1, side, platform, source: pin, before: pins.before, candidate: pins.candidate,
      driverHead: process.env.GITHUB_SHA, run: process.env.GITHUB_RUN_ID,
      driver: driverBefore, officialNativeMetadata: {
        driver: pins.metadataDriver, run: pins.metadataRun, artifact: pins.metadataArtifact,
        artifactSha256: pins.metadataArtifactSha256, platformPin: pins.platforms[platform],
      },
      runtime: { platform: process.platform, architecture: process.arch, node: process.version },
      inheritedNativeEnvironmentNames: Object.keys(nativeEnvironment).filter((name) => allowed.has(name.toUpperCase())).sort(),
      qualification: pins.qualification,
    });
    writeJson("source-initial.json", proof("initial"));
    const vitest = path.join(sourceRoot, "node_modules/vitest/vitest.mjs");
    const database = await phase("database", [
      process.execPath, vitest, "run", "--maxWorkers=1", "--no-file-parallelism",
      pins.databaseSuite, "--reporter=verbose", "--reporter=json",
      "--outputFile=" + path.join(live, "database.json"),
    ], path.join(sourceRoot, "apps/server"), 5 * 60_000, nativeEnvironment);
    attempt("database-verification", () => {
      const accounting = report("database", path.join(sourceRoot, "apps/server", pins.databaseSuite));
      verifyDatabase(accounting, database); databaseVerification = accounting;
      writeJson("database-qualification.json", { accounting, qualification: pins.qualification.ownership });
    });
    const archive = await download();
    const extraction = await phase("extract", [
      "python", path.join(directory, "extract.py"), archive, path.join(privateDirectory, "extracted"),
      path.join(directory, "pins.json"), platform,
    ], privateDirectory, 60_000);
    completeRoot(extraction);
    const extracted = JSON.parse(readFileSync(path.join(frozen, "extract.log"), "utf8"));
    writeJson("extraction.json", extracted);
    binary = path.resolve(extracted.executable);
    assert.equal(binary, path.join(privateDirectory, "extracted", platform === "windows-x64" ? "opencode.exe" : "opencode"));
    assert(lstatSync(binary).isFile());
    binaryBefore = metadata("opencode-native-binary", readFileSync(binary));
    assert.equal(binaryBefore.sha256, extracted.members.find((entry) => entry.path.includes("/bin/")).sha256);
    assert.equal(binaryBefore.bytes, extracted.members.find((entry) => entry.path.includes("/bin/")).bytes);
    writeJson("binary-before.json", { ...binaryBefore, path: binary, version: pins.version });
    const version = await phase("version", [binary, "--version"], privateDirectory, 30_000, nativeEnvironment);
    completeRoot(version);
    assert.equal(readFileSync(path.join(frozen, "version.log"), "utf8").trim(), "opencode v" + pins.version);
    installOverlay();
    writeJson("source-after-overlay.json", proof("after-overlay"));
    const native = await phase("native", [
      process.execPath, vitest, "run", "--maxWorkers=1", "--no-file-parallelism",
      path.relative(path.join(sourceRoot, "apps/server"), path.join(sourceRoot, pins.testPath)),
      "--testNamePattern=" + pins.nativeTestName, "--reporter=verbose", "--reporter=json",
      "--outputFile=" + path.join(live, "native.json"),
    ], path.join(sourceRoot, "apps/server"), 15 * 60_000, {
      ...nativeEnvironment, SYNARA_NATIVE_STARTUP_PROBE: "1", OPENCODE_LIVE_BINARY: binary,
      NATIVE_STARTUP_EVIDENCE: nativeOutput,
    });
    attempt("native-verification", () => {
      const accounting = report("native", path.join(sourceRoot, pins.testPath));
      verifyNative(accounting, native); nativeVerification = accounting;
    });
    for (const scenario of scenarios) {
      attempt("scenario:" + scenario, () => {
        const file = scenario + ".ndjson";
        capture(path.join(nativeOutput, file), file, 16 * 1024 * 1024);
        const raw = readFileSync(path.join(frozen, file), "utf8");
        assert(raw.endsWith("\n"), "Partial final native observation is retained and refused.");
        const lines = raw.slice(0, -1).split("\n");
        assert(lines.length > 0 && lines.every((line) => line.length > 0));
        const events = lines.map((line) => JSON.parse(line));
        const summary = summarizeScenario(scenario, events);
        writeJson(scenario + "-phases.json", summary);
        scenarioSummaries.push(summary);
        verifyScenario(scenario, events, summary);
      });
    }
    const types = await phase("server-types-with-probe", [
      process.execPath, path.join(sourceRoot, "node_modules/@typescript/native/bin/tsc"),
      "--noEmit", "--tsBuildInfoFile", "node_modules/.cache/typescript-native.tsbuildinfo",
    ], path.join(sourceRoot, "apps/server"), 10 * 60_000);
    attempt("server-types-result", () => completeRoot(types));
  } catch (error) { failures.push({ phase: "validation", ...recordError(error) }); }
  finally {
    for (const name of ["database", "native"])
      if (!snapshots.has(name + ".json"))
        attempt("final-report:" + name, () => capture(path.join(live, name + ".json"), name + ".json"));
    for (const scenario of scenarios)
      if (!snapshots.has(scenario + ".ndjson"))
        attempt("final-observation:" + scenario, () =>
          capture(path.join(nativeOutput, scenario + ".ndjson"), scenario + ".ndjson", 16 * 1024 * 1024));
    if (binary && binaryBefore)
      attempt("binary-final", () => {
        assert(lstatSync(binary).isFile());
        const after = metadata("opencode-native-binary", readFileSync(binary));
        writeJson("binary-after.json", { ...after, path: binary });
        assert.deepEqual(after, binaryBefore);
      });
    for (const [relative, receipt] of created)
      attempt("remove-owned-probe:" + relative, () => {
        const file = path.join(sourceRoot, relative);
        assert(lstatSync(file).isFile()); assert.equal(gitBlob(readFileSync(file)), receipt.gitBlob);
        unlinkSync(file);
      });
    created.clear();
    for (const [relative, entry] of overlays)
      attempt("restore-original-test:" + relative, () => {
        const file = path.join(sourceRoot, relative);
        assert(lstatSync(file).isFile());
        assert.equal(gitBlob(readFileSync(file)), entry.gitBlob, "Refuse overwriting changed test source.");
        writeFileSync(file, entry.original);
      });
    overlays.clear();
    attempt("source-restored", () => writeJson("source-restored.json", proof("restored")));
    attempt("driver-final", () => {
      const after = verifyDriver(); assert(driverBefore); assert.deepEqual(after, driverBefore);
      writeJson("driver-final.json", { head: process.env.GITHUB_SHA, files: after });
    });
    writeJson("snapshot-captures.json", [...snapshots.values()]);
    const exitCode = failures.length ? 1 : 0;
    writeJson("result.json", {
      schemaVersion: 1, side, platform, source: pin, driverHead: process.env.GITHUB_SHA,
      failures, phases, databaseVerification, nativeVerification, scenarioSummaries,
      exitCode, verificationPassed: failures.length === 0,
      rootObserverProvesDescendantExit: false, qualification: pins.qualification,
    });
    writeJson("manifest.json", {
      schemaVersion: 1, side, platform, source: pin, driverHead: process.env.GITHUB_SHA,
      capturedAt: now(), files: walkFiles(frozen).map((relative) =>
        metadata(relative, readFileSync(path.join(frozen, relative)))),
    });
    console.log(JSON.stringify({
      side, platform, source: pin.sha, driver: process.env.GITHUB_SHA, exitCode,
      verificationPassed: failures.length === 0,
      database: databaseVerification ? { passed: databaseVerification.passed, failed: databaseVerification.failed } : null,
      native: nativeVerification ? { passed: nativeVerification.passed, failed: nativeVerification.failed } : null,
      scenarios: scenarioSummaries.map((row) => ({
        scenario: row.scenario, spans: row.spans.length, settledDeliveries: row.settlements.length,
        actualScopeClose: row.scopeClose, leaseTimeout: row.leaseTimeout, ownedExit: row.ownedExit,
      })),
      failures,
    }));
    process.exitCode = exitCode;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

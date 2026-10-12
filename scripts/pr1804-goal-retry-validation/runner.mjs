import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { observeCommand } from "./owned-command-observer.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const driverRoot = path.resolve(scriptDir, "../..");
const pins = JSON.parse(readFileSync(path.join(scriptDir, "pins.json"), "utf8"));
const now = () => new Date().toISOString();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlob = (bytes) =>
  createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
const recordError = (error) => ({
  name: error.name,
  code: error.code ?? null,
  message: error.message,
});
const git = (root, ...args) =>
  execFileSync("git", ["-C", root, ...args], {
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
const driverPaths = [
  ".github/workflows/pr1804-goal-retry-validation.yml",
  "scripts/pr1804-goal-retry-validation/README.md",
  "scripts/pr1804-goal-retry-validation/pins.json",
  "scripts/pr1804-goal-retry-validation/runner.mjs",
  "scripts/pr1804-goal-retry-validation/owned-command-observer.mjs",
];

function verifyDriver() {
  assert.equal(git(driverRoot, "rev-parse", "HEAD").toString().trim(), process.env.GITHUB_SHA);
  return driverPaths.map((relative) => {
    const current = readFileSync(path.join(driverRoot, relative));
    const expected = git(driverRoot, "show", "HEAD:" + relative);
    assert(current.equals(expected), "Driver bytes changed: " + relative);
    return { path: relative, bytes: current.length, sha256: digest(current), gitBlob: gitBlob(current) };
  });
}

function sourceProof(root, pin, overlays, stage) {
  assert.equal(git(root, "rev-parse", "HEAD").toString().trim(), pin.sha);
  assert.equal(git(root, "rev-parse", "HEAD^{tree}").toString().trim(), pin.tree);
  const listing = git(root, "ls-tree", "-r", "-z", "HEAD");
  let count = 0;
  for (const row of listing.toString().split("\0").filter(Boolean)) {
    const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(row);
    assert(match, "Unexpected tracked entry " + row.slice(0, 120));
    const [, mode, sha, relative] = match;
    const file = path.join(root, relative);
    const stat = lstatSync(file);
    assert(stat.isFile(), "Tracked path is not a regular file: " + relative);
    assert.equal((stat.mode & 0o111) !== 0, mode === "100755", relative);
    assert.equal(gitBlob(readFileSync(file)), overlays.get(relative)?.sha ?? sha, relative);
    count++;
  }
  assert.equal(count, pin.files);
  const differences = git(root, "diff", "--name-only", "HEAD", "--")
    .toString().trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(differences, [...overlays.keys()].sort());
  assert.equal(
    gitBlob(readFileSync(path.join(root, ".github/actions/setup-workspace/action.yml"))),
    pins.setupWorkspaceBlob,
  );
  return {
    stage, at: now(), head: pin.sha, tree: pin.tree, trackedFiles: count,
    listingSha256: digest(listing), rawBytesAndModesVerified: true,
    exactOverlays: [...overlays.values()].map(({ original, ...entry }) => entry),
    untrackedQualification:
      "Tracked source bytes and modes are exhaustive. Dependency/build caches and the separately pinned nested driver checkout are untracked and are not represented as product source.",
  };
}

function safeRelative(relative) {
  assert(relative && !path.isAbsolute(relative));
  assert(relative.split(/[\\/]/).every((part) => part && part !== "." && part !== ".." && !part.startsWith(".")));
  return relative;
}

function snapshotFile(livePath, destination, capBytes) {
  const captureStartedAt = now();
  if (!existsSync(livePath)) return { missing: true, captureStartedAt, captureCompletedAt: now() };
  const fd = openSync(livePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let receipt;
  let bytes;
  try {
    const before = fstatSync(fd);
    assert(before.isFile(), "Only regular diagnostic output may be retained");
    const length = Math.min(before.size, capBytes);
    bytes = Buffer.alloc(length);
    let used = 0;
    while (used < length) {
      const amount = readSync(fd, bytes, used, length - used, used);
      if (amount === 0) break;
      used += amount;
    }
    bytes = bytes.subarray(0, used);
    const after = fstatSync(fd);
    assert.equal(after.dev, before.dev);
    assert.equal(after.ino, before.ino);
    receipt = {
      captureStartedAt, captureCompletedAt: now(),
      observedInitialBytes: before.size, observedEndBytes: after.size,
      capturedBytes: bytes.length, capBytes,
      capped: before.size > capBytes || after.size > capBytes,
      observedSizeChange: before.size !== after.size,
      shortRead: bytes.length !== length,
      sha256: digest(bytes), gitBlob: gitBlob(bytes),
      qualification:
        "One fixed retained byte prefix from an owned file descriptor. Later live writes are neither uploaded nor included in the manifest; root exit/pipe close do not prove every descendant has exited.",
    };
  } finally {
    closeSync(fd);
  }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o444 });
  return receipt;
}

function completeRoot(result, expectedExit) {
  assert(result, "No command result");
  assert.equal(result.actualRootExitObserved, true);
  assert.equal(result.actualRootExit, expectedExit);
  assert.equal(result.actualRootSignal, null);
  assert.equal(result.closeObserved, true);
  assert.equal(result.closeCode, expectedExit);
  assert.equal(result.closeSignal, null);
  assert.equal(result.deadline, false);
  assert.equal(result.capped, false);
  assert.equal(result.forcedOutputCutoff, false);
  assert.deepEqual(result.processErrors, []);
  assert.deepEqual(result.outputErrors, []);
  assert.equal(result.observerStatus, expectedExit);
}

function selectedAssertions(report, names) {
  const all = report.testResults.flatMap((suite) => suite.assertionResults);
  return names.map((title) => {
    const found = all.filter((entry) => entry.title === title);
    assert.equal(found.length, 1, "Expected exactly one test: " + title);
    assert(["passed", "failed"].includes(found[0].status), "Selected test did not execute: " + title);
    return { title, status: found[0].status, failureMessages: found[0].failureMessages ?? [] };
  });
}

function verifyReport(report, variant, result, sourceRoot) {
  assert(Array.isArray(report.testResults) && report.testResults.length === 1);
  const names = variant === "before" ? pins.goalNames : [...pins.originalNames, ...pins.goalNames];
  const selected = selectedAssertions(report, names);
  assert.deepEqual(
    report.testResults.map((suite) => path.resolve(suite.name)),
    [path.join(sourceRoot, "apps/server", pins.suite)],
  );
  if (variant === "after") {
    completeRoot(result, 0);
    assert.equal(report.success, true);
    assert.equal(report.numFailedTests, 0);
    assert.equal(report.numPendingTests, 0);
    assert.equal(report.numTodoTests, 0);
    assert(selected.every((entry) => entry.status === "passed"));
    assert(report.testResults.every((suite) =>
      suite.status === "passed" && suite.assertionResults.every((entry) => entry.status === "passed"),
    ));
  } else {
    completeRoot(result, 1);
    assert.equal(report.success, false);
    assert.equal(selected[0].status, "failed", "The unpaused goal must expose the missing retry");
    assert.equal(selected[1].status, "passed", "The paused goal must remain an unchanged negative control");
    assert.equal(report.numFailedTests, 1, "Another failure requires separate diagnosis");
  }
  return {
    selected,
    totals: {
      passed: report.numPassedTests, failed: report.numFailedTests,
      pending: report.numPendingTests, todo: report.numTodoTests,
    },
    baselineFailureObserved: variant === "before",
    qualification:
      "Real SQLite projection/delivery and an actually held checkpoint coordinator lease with controlled provider-service fixtures. This is not a native provider launch or the original 30-second empirical phase-budget qualification.",
    causalQualification:
      "The fixed raw assertion messages must be read before interpreting the Before failure as causal proof.",
  };
}

async function main() {
  const variant = process.argv[2];
  assert(pins.variants.includes(variant));
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_WORKSPACE && process.env.GITHUB_SHA);
  const sourceRoot = path.resolve(process.env.GITHUB_WORKSPACE);
  const sourcePin = variant === "before" ? pins.before : pins.candidate;
  const root = path.join(process.env.RUNNER_TEMP, "pr1804-goal-retry-" + variant);
  const live = path.join(root, "live");
  const frozen = path.join(root, "frozen");
  assert(!existsSync(root), "Refuse reused diagnostic output");
  mkdirSync(live, { recursive: true });
  mkdirSync(frozen);
  const writeJson = (relative, value) => {
    const target = path.join(frozen, safeRelative(relative));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  };
  const failures = [];
  const phases = [];
  const overlays = new Map();
  let reportVerification = null;
  let testResult = null;
  const capture = (name, filename, cap) => {
    const receipt = snapshotFile(path.join(live, filename), path.join(frozen, filename), cap);
    writeJson(name + "-snapshot.json", receipt);
    assert(!receipt.missing && !receipt.capped && !receipt.observedSizeChange && !receipt.shortRead,
      "Incomplete fixed snapshot: " + filename);
    return receipt;
  };
  const phase = async (name, command, cwd, deadlineMs) => {
    let result = null;
    try {
      writeJson("source-before-" + name + ".json", sourceProof(sourceRoot, sourcePin, overlays, "before-" + name));
      result = await observeCommand({
        command, cwd, deadlineMs, drainMs: 10_000,
        capBytes: 32 * 1024 * 1024, logPath: path.join(live, name + ".log"),
      });
      writeJson(name + "-process.json", result);
    } catch (error) {
      failures.push({ phase: name, ...recordError(error) });
    } finally {
      try { capture(name + "-log", name + ".log", 32 * 1024 * 1024); }
      catch (error) { failures.push({ phase: name + "-snapshot", ...recordError(error) }); }
      try {
        writeJson("source-after-" + name + ".json", sourceProof(sourceRoot, sourcePin, overlays, "after-" + name));
      } catch (error) { failures.push({ phase: name + "-source", ...recordError(error) }); }
      phases.push({ name, result });
    }
    return result;
  };
  try {
    writeJson("provenance.json", {
      variant, source: sourcePin, candidate: pins.candidate, author: pins.originalAuthorHead,
      driverHead: process.env.GITHUB_SHA, driver: verifyDriver(),
      environment: { platform: process.platform, architecture: process.arch, node: process.version },
      qualification: pins.qualification,
      productionSourceIsNeverFormattedInPlace: true,
    });
    writeJson("source-before-overlay.json", sourceProof(sourceRoot, sourcePin, overlays, "before-overlay"));
    writeJson("source-after-overlay.json", sourceProof(sourceRoot, sourcePin, overlays, "after-overlay"));
    const testCommand = [
      "bunx", "vitest", "run", "--maxWorkers=1", "--no-file-parallelism",
      "--reporter=verbose", "--reporter=json", "--outputFile=" + path.join(live, "vitest.json"),
      pins.suite,
    ];
    if (variant === "before")
      testCommand.push("--testNamePattern", "(?:" + pins.goalNames.map((name) =>
        name.replace(/[.*+?^$()|[\]\\]/g, "\\$&"),
      ).join("|") + ")$");
    testResult = await phase("tests", testCommand, path.join(sourceRoot, "apps/server"), 25 * 60_000);
    try {
      capture("vitest-report", "vitest.json", 32 * 1024 * 1024);
      const report = JSON.parse(readFileSync(path.join(frozen, "vitest.json"), "utf8"));
      reportVerification = verifyReport(report, variant, testResult, sourceRoot);
      writeJson("test-verification.json", reportVerification);
    } catch (error) {
      failures.push({ phase: "test-verification", ...recordError(error) });
    }
    if (variant === "after") {
      const changed = pins.feature.map((entry) => entry.path);
      const checks = [
        ["types", ["bun", "run", "--cwd", "apps/server", "typecheck"], 12 * 60_000],
        ["format", ["bunx", "oxfmt", "--check", ...changed], 3 * 60_000],
        ["lint", ["bunx", "oxlint", "--report-unused-disable-directives", ...changed], 5 * 60_000],
        ["sync-fs", ["bun", "run", "server-sync-fs:check"], 3 * 60_000],
      ];
      for (const [name, command, deadline] of checks) {
        const result = await phase(name, command, sourceRoot, deadline);
        try { completeRoot(result, 0); }
        catch (error) { failures.push({ phase: name + "-verification", ...recordError(error) }); }
        if (name === "format" && result && result.observerStatus !== 0) {
          const copyRoot = path.join(live, "formatted-source");
          for (const relative of changed) {
            const target = path.join(copyRoot, relative);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, readFileSync(path.join(sourceRoot, relative)), { flag: "wx" });
          }
          const formatted = await phase("format-copy", [
            "bunx", "oxfmt", "--config", path.join(sourceRoot, ".oxfmtrc.json"),
            ...changed.map((relative) => path.join(copyRoot, relative)),
          ], sourceRoot, 3 * 60_000);
          try { completeRoot(formatted, 0); }
          catch (error) { failures.push({ phase: "format-copy-verification", ...recordError(error) }); }
          for (const relative of changed) {
            const filename = "formatted-source/" + relative;
            try { capture("formatted-" + relative.replaceAll("/", "_"), filename, 2 * 1024 * 1024); }
            catch (error) { failures.push({ phase: "formatted-copy", path: relative, ...recordError(error) }); }
          }
        }
      }
    }
  } catch (error) {
    failures.push({ phase: "setup-or-overlay", ...recordError(error) });
  } finally {
    for (const [relative, entry] of overlays) {
      try {
        const target = path.join(sourceRoot, relative);
        assert.equal(gitBlob(readFileSync(target)), entry.sha, "Refuse restoring over changed overlay");
        writeFileSync(target, entry.original);
      } catch (error) { failures.push({ phase: "restore", path: relative, ...recordError(error) }); }
    }
    try {
      writeJson("source-restored.json", sourceProof(sourceRoot, sourcePin, new Map(), "restored"));
    } catch (error) { failures.push({ phase: "restored-source", ...recordError(error) }); }
    const actualTestStatus = testResult?.observerStatus ?? 1;
    const exitCode = failures.length ? (actualTestStatus || 1) : actualTestStatus;
    writeJson("result.json", {
      variant, source: sourcePin, failures, testVerification: reportVerification, phases, exitCode,
      verificationPassed: failures.length === 0,
      sourceValidationPassed: variant === "after" && failures.length === 0,
      expectedBaselineFailureNeverConvertedToJobSuccess: true,
      descendantExitProven: false,
    });
    const inventory = (relative = "") => readdirSync(path.join(frozen, relative)).sort().flatMap((name) => {
      assert(!name.startsWith("."), "Hidden evidence would be omitted by artifact defaults");
      const filename = relative ? relative + "/" + name : name;
      const stat = lstatSync(path.join(frozen, filename));
      if (stat.isDirectory()) return inventory(filename);
      assert(stat.isFile(), "Only regular frozen evidence is exported");
      const bytes = readFileSync(path.join(frozen, filename));
      return [{ path: filename, bytes: bytes.length, sha256: digest(bytes), gitBlob: gitBlob(bytes) }];
    });
    writeJson("manifest.json", {
      schemaVersion: 1, source: sourcePin, driverHead: process.env.GITHUB_SHA,
      variant, capturedAt: now(), files: inventory(),
    });
    console.log(JSON.stringify({
      variant, source: sourcePin.sha, verificationPassed: failures.length === 0,
      actualTestStatus, exitCode, totals: reportVerification?.totals, failures,
    }));
    process.exitCode = exitCode;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();

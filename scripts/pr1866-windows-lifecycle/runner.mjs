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
  ".github/workflows/pr1866-windows-lifecycle.yml",
  "scripts/pr1866-windows-lifecycle/README.md",
  "scripts/pr1866-windows-lifecycle/pins.json",
  "scripts/pr1866-windows-lifecycle/runner.mjs",
  "scripts/pr1866-windows-lifecycle/owned-command-observer.mjs",
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
    if (process.platform !== "win32")
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
    modeQualification: process.platform === "win32"
      ? "Git tree modes and raw file bytes verified; POSIX executable permission bits are not observable on Windows."
      : "Git tree and actual POSIX executable modes verified.",
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
  assert.equal(variant, "windows-native");
  completeRoot(result, 0);
  assert.equal(report.success, true);
  assert.equal(report.numPassedTests, 2);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  assert(Array.isArray(report.testResults) && report.testResults.length === 1);
  assert.deepEqual(report.testResults.map((suite) => path.resolve(suite.name)),
    [path.join(sourceRoot, "apps/server", pins.suite)]);
  const selected = selectedAssertions(report, pins.nativeNames);
  assert(selected.every((entry) => entry.status === "passed"));
  assert(report.testResults.every((suite) =>
    suite.status === "passed" && suite.assertionResults.every((entry) => entry.status === "passed"),
  ));
  return {
    selected,
    totals: { passed: 2, failed: 0, pending: 0, todo: 0 },
    qualification:
      "Unmodified production Codex adapter and both original author protocol cases on Windows. The isolated Node app-server fixture performs no model inference or credentialed provider request.",
  };
}

async function main() {
  const variant = process.argv[2];
  assert.equal(variant, "windows-native");
  assert.equal(process.platform, "win32");
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_WORKSPACE && process.env.GITHUB_SHA);
  const sourceRoot = path.resolve(process.env.GITHUB_WORKSPACE);
  const sourcePin = pins.candidate;
  const root = path.join(process.env.RUNNER_TEMP, "pr1866-windows-lifecycle-" + variant);
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
  let driverBefore = null;
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
    driverBefore = verifyDriver();
    writeJson("provenance.json", {
      variant, source: sourcePin, candidate: pins.candidate, author: pins.originalAuthorHead,
      driverHead: process.env.GITHUB_SHA, driver: driverBefore,
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
    testResult = await phase("tests", testCommand, path.join(sourceRoot, "apps/server"), 25 * 60_000);
    try {
      capture("vitest-report", "vitest.json", 32 * 1024 * 1024);
      const report = JSON.parse(readFileSync(path.join(frozen, "vitest.json"), "utf8"));
      reportVerification = verifyReport(report, variant, testResult, sourceRoot);
      writeJson("test-verification.json", reportVerification);
    } catch (error) {
      failures.push({ phase: "test-verification", ...recordError(error) });
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
    try {
      const driverAfter = verifyDriver();
      assert(driverBefore, "Initial driver identity was not established");
      assert.deepEqual(driverAfter, driverBefore, "Driver bytes changed during execution");
      writeJson("driver-final.json", { head: process.env.GITHUB_SHA, files: driverAfter });
    } catch (error) {
      failures.push({ phase: "driver-final", ...recordError(error) });
    }
    const actualTestStatus = testResult?.observerStatus ?? 1;
    const exitCode = failures.length ? (actualTestStatus || 1) : actualTestStatus;
    writeJson("result.json", {
      variant, source: sourcePin, failures, testVerification: reportVerification, phases, exitCode,
      verificationPassed: failures.length === 0,
      sourceValidationPassed: failures.length === 0,
      originalAssertionsUnchanged: true,
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

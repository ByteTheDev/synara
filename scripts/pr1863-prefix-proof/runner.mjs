import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { observeCommand } from "./owned-command-observer.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const driverRoot = path.resolve(scriptDir, "../..");
const pins = JSON.parse(readFileSync(path.join(scriptDir, "pins.json"), "utf8"));
const now = () => new Date().toISOString();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) => createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
const recordError = (error) => ({ name: error.name, code: error.code ?? null, message: error.message });
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
const driverPaths = [
  ".github/workflows/pr1863-prefix-proof.yml",
  "scripts/pr1863-prefix-proof/README.md",
  "scripts/pr1863-prefix-proof/pins.json",
  "scripts/pr1863-prefix-proof/probe.ts",
  "scripts/pr1863-prefix-proof/runner.mjs",
  "scripts/pr1863-prefix-proof/owned-command-observer.mjs",
];

function driverProof() {
  assert.equal(git(driverRoot, "rev-parse", "HEAD").toString().trim(), process.env.GITHUB_SHA);
  return driverPaths.map((relative) => {
    const file = path.join(driverRoot, relative);
    assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
    const bytes = readFileSync(file);
    assert(bytes.equals(git(driverRoot, "show", "HEAD:" + relative)), "Driver bytes changed");
    return { path: relative, bytes: bytes.length, gitBlob: blob(bytes), sha256: hash(bytes) };
  });
}

function sourceProof(root, pin, overlays, extras, stage) {
  assert.equal(git(root, "rev-parse", "HEAD").toString().trim(), pin.sha);
  assert.equal(git(root, "rev-parse", "HEAD^{tree}").toString().trim(), pin.tree);
  const listing = git(root, "ls-tree", "-r", "-z", "HEAD");
  const index = new Map(git(root, "ls-files", "--stage", "-z").toString().split("\0").filter(Boolean).map((line) => {
    const match = /^(\d+) ([0-9a-f]{40}) 0\t(.+)$/.exec(line);
    assert(match, "Unexpected index entry");
    return [match[3], { mode: match[1], sha: match[2] }];
  }));
  let count = 0;
  for (const row of listing.toString().split("\0").filter(Boolean)) {
    const match = /^(\d+) blob ([0-9a-f]{40})\t(.+)$/.exec(row);
    assert(match, "Unexpected tracked entry");
    const [, mode, sha, relative] = match;
    assert.deepEqual(index.get(relative), { mode, sha }, "Index changed: " + relative);
    const file = path.join(root, relative);
    const stat = lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), "Non-regular source");
    if (process.platform !== "win32") assert.equal((stat.mode & 0o111) !== 0, mode === "100755", relative);
    assert.equal(blob(readFileSync(file)), overlays.get(relative)?.sha ?? sha, relative);
    count++;
  }
  assert.equal(count, pin.files);
  assert.equal(index.size, pin.files);
  for (const [relative, expected] of extras) {
    const file = path.join(root, relative);
    assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
    assert.equal(blob(readFileSync(file)), expected);
  }
  const differences = git(root, "diff", "--name-only", "HEAD", "--").toString().trim().split("\n").filter(Boolean).sort();
  assert.deepEqual(differences, [...overlays.keys()].sort());
  const untracked = git(root, "ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean);
  assert(untracked.every((relative) => relative === ".pr-driver/" || extras.has(relative)), "Unexpected untracked source");
  return {
    stage, at: now(), head: pin.sha, tree: pin.tree, trackedFiles: count,
    listingSha256: hash(listing), rawBytesAndIndexModesVerified: true,
    filesystemExecutableBitsChecked: process.platform !== "win32",
    filesystemModeQualification: "Windows verifies committed/index modes; POSIX also checks filesystem executable bits.",
    overlays: [...overlays.entries()].map(([relative, value]) => ({ path: relative, gitBlob: value.sha })),
    extras: [...extras.entries()].map(([relative, gitBlob]) => ({ path: relative, gitBlob })),
    untracked,
  };
}

function snapshot(live, destination, cap) {
  const startedAt = now();
  if (!existsSync(live)) return { missing: true, startedAt, completedAt: now() };
  const initialPath = lstatSync(live);
  assert(initialPath.isFile() && !initialPath.isSymbolicLink(), "Non-regular live evidence");
  const fd = openSync(live, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  let receipt;
  try {
    const before = fstatSync(fd);
    const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
    assert(before.isFile() && sameIdentity(before, initialPath), "Evidence identity changed before read");
    const length = Math.min(before.size, cap);
    bytes = Buffer.alloc(length);
    let used = 0;
    while (used < length) {
      const amount = readSync(fd, bytes, used, length - used, used);
      if (!amount) break;
      used += amount;
    }
    bytes = bytes.subarray(0, used);
    const after = fstatSync(fd);
    const finalPath = lstatSync(live);
    receipt = {
      startedAt, completedAt: now(), capBytes: cap,
      initialBytes: before.size, endBytes: after.size, capturedBytes: bytes.length,
      capped: before.size > cap || after.size > cap,
      shortRead: used !== length,
      changed: !sameIdentity(before, after) || !sameIdentity(before, finalPath) ||
        before.size !== after.size || before.size !== finalPath.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.mtimeMs !== finalPath.mtimeMs || before.ctimeMs !== finalPath.ctimeMs,
      sha256: hash(bytes), gitBlob: blob(bytes),
      qualification: "One fixed descriptor read. Only this copied prefix is uploaded; later live writes cannot alter it.",
    };
  } finally { closeSync(fd); }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o444 });
  return receipt;
}

function completeRoot(result, code) {
  assert(result);
  assert.equal(result.actualRootExitObserved, true);
  assert.equal(result.actualRootExit, code);
  assert.equal(result.actualRootSignal, null);
  assert.equal(result.closeObserved, true);
  assert.equal(result.closeCode, code);
  assert.equal(result.closeSignal, null);
  assert.equal(result.deadline, false);
  assert.equal(result.capped, false);
  assert.equal(result.forcedOutputCutoff, false);
  assert.deepEqual(result.processErrors, []);
  assert.deepEqual(result.outputErrors, []);
  assert.equal(result.observerStatus, code);
}

function verifyTests(report, variant, result, sourceRoot) {
  completeRoot(result, variant === "before" ? 1 : 0);
  const suiteNames = report.testResults.map((suite) => path.resolve(suite.name)).sort();
  assert.deepEqual(suiteNames, pins.suites.map((suite) => path.join(sourceRoot, "apps/server", suite)).sort());
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
  assert.equal(assertions.length, pins.expectedTotal);
  const selected = pins.names.map((title) => {
    const matches = assertions.filter((entry) => entry.title === title);
    assert.equal(matches.length, 1, "Missing/ambiguous original prefix test");
    return { title, status: matches[0].status, failureMessages: matches[0].failureMessages ?? [] };
  });
  const filtered = process.platform === "win32";
  const expectedFailures = variant === "before" ? 3 : 0;
  assert.equal(report.numFailedTests, expectedFailures);
  assert.equal(report.numPassedTests, filtered ? 3 - expectedFailures : pins.expectedTotal - expectedFailures);
  assert.equal(report.numPendingTests, filtered ? pins.expectedTotal - 3 : 0);
  assert.equal(report.numTodoTests, 0);
  assert.equal(report.success, variant === "after");
  assert(selected.every((entry) => entry.status === (variant === "before" ? "failed" : "passed")));
  return { selected, passed: report.numPassedTests, failed: report.numFailedTests,
    unselected: report.numPendingTests, total: pins.expectedTotal,
    selection: filtered ? "Three named prefix regressions; every other case is explicitly unselected." : "All three full source suites, unfiltered.",
    causalQualification: "Read original failure messages before interpreting a Before failure as proof of the prefix defect." };
}

function verifyProbe(report, variant, result, sourcePin) {
  completeRoot(result, variant === "before" ? 1 : 0);
  assert.deepEqual(report.source, sourcePin);
  assert.equal(report.platform, process.platform);
  assert.deepEqual(report.scenarios.map((entry) => entry.name), ["default", "noprefix", "mnemonic", "custom", "color"]);
  assert(report.cleanup.filter((entry) => entry.runtimeDisposed === true).length === 5);
  assert(report.cleanup.filter((entry) => entry.ownedTreeRemoved === true).length === 5);
  assert.equal(report.cleanup.at(-1).rootRemoved, true);
  assert(report.failures.every((entry) => typeof entry.check === "string"), "Fixture/lifecycle failure is not a prefix result");
  assert.equal(Object.keys(report.scenarios[0].checks).length, 11);
  assert(Object.values(report.scenarios[0].checks).every((value) => value === true), "Normal-prefix positive control failed");
  if (variant === "after") {
    assert.deepEqual(report.failures, []);
    assert(report.scenarios.every((entry) => Object.keys(entry.checks).length === 11 &&
      Object.values(entry.checks).every((value) => value === true)));
  } else {
    assert(report.failures.length > 0 && report.failures.every((entry) => entry.scenario !== "default"));
  }
  return { scenarios: report.scenarios.map(({ name, config, checks }) => ({ name, config, checks })),
    actualFailures: report.failures, expectedBaselineFailureMatched: variant === "before",
    qualification: report.qualification };
}

async function main() {
  const variant = process.argv[2];
  assert(["before", "after"].includes(variant));
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_WORKSPACE && process.env.GITHUB_SHA);
  const sourceRoot = path.resolve(process.env.GITHUB_WORKSPACE);
  const pin = pins[variant];
  const root = path.join(process.env.RUNNER_TEMP, "pr1863-prefix-" + variant);
  assert(!existsSync(root));
  const live = path.join(root, "live");
  const frozen = path.join(root, "frozen");
  mkdirSync(live, { recursive: true });
  mkdirSync(frozen);
  const write = (name, value) => {
    assert(/^[a-zA-Z0-9_.-]+$/.test(name) && !name.startsWith("."));
    writeFileSync(path.join(frozen, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  };
  const overlays = new Map();
  const extras = new Map();
  const failures = [];
  const phases = [];
  let tests = null;
  let probe = null;
  const capture = (name, cap) => {
    const receipt = snapshot(path.join(live, name), path.join(frozen, name), cap);
    write(name + ".snapshot.json", receipt);
    assert(!receipt.missing && !receipt.capped && !receipt.shortRead && !receipt.changed, "Incomplete fixed snapshot: " + name);
    return readFileSync(path.join(frozen, name));
  };
  const phase = async (name, command, cwd, deadlineMs) => {
    let result = null;
    try {
      write("source-before-" + name + ".json", sourceProof(sourceRoot, pin, overlays, extras, "before-" + name));
      result = await observeCommand({ command, cwd, deadlineMs, drainMs: 10_000,
        capBytes: 16 * 1024 * 1024, logPath: path.join(live, name + ".log") });
      write(name + ".process.json", result);
    } catch (error) { failures.push({ phase: name, ...recordError(error) }); }
    finally {
      try { capture(name + ".log", 16 * 1024 * 1024); }
      catch (error) { failures.push({ phase: name + "-snapshot", ...recordError(error) }); }
      try { write("source-after-" + name + ".json", sourceProof(sourceRoot, pin, overlays, extras, "after-" + name)); }
      catch (error) { failures.push({ phase: name + "-source", ...recordError(error) }); }
      phases.push({ name, result });
    }
    return result;
  };
  try {
    write("provenance.json", { variant, source: pin, author: pins.after, driverHead: process.env.GITHUB_SHA,
      driver: driverProof(), platform: process.platform, architecture: process.arch, node: process.version,
      gitVersion: git(sourceRoot, "--version").toString().trim(), qualification: pins.qualification });
    write("source-initial.json", sourceProof(sourceRoot, pin, overlays, extras, "initial"));
    for (const relative of pins.testPaths) {
      const feature = pins.feature.find((row) => row.path === relative);
      const expected = git(driverRoot, "show", "HEAD:" + relative);
      assert.equal(blob(expected), feature.after);
      const target = path.join(sourceRoot, relative);
      const current = readFileSync(target);
      assert.equal(blob(current), feature[variant]);
      if (variant === "before") {
        overlays.set(relative, { sha: feature.after, original: current });
        writeFileSync(target, expected);
      }
    }
    write("source-tests-ready.json", sourceProof(sourceRoot, pin, overlays, extras, "tests-ready"));
    const command = ["bun", "run", "test", "--", ...pins.suites, "--reporter=verbose", "--reporter=json",
      "--outputFile=" + path.join(live, "tests.json")];
    if (process.platform === "win32") command.push("--testNamePattern", "(?:" + pins.names.map((name) =>
      name.replace(/[.*+?^$()|[\]\\]/g, "\\$&")).join("|") + ")$");
    const testResult = await phase("tests", command, path.join(sourceRoot, "apps/server"), 20 * 60_000);
    try {
      tests = verifyTests(JSON.parse(capture("tests.json", 16 * 1024 * 1024).toString()), variant, testResult, sourceRoot);
      write("tests-verification.json", tests);
    } catch (error) { failures.push({ phase: "tests-verification", ...recordError(error) }); }

    const probeBytes = readFileSync(path.join(scriptDir, "probe.ts"));
    assert.equal(blob(probeBytes), pins.probeBlob);
    const destination = path.join(sourceRoot, pins.probeDestination);
    assert(!existsSync(destination), "Refuse overwriting a probe path");
    writeFileSync(destination, probeBytes, { flag: "wx" });
    extras.set(pins.probeDestination, pins.probeBlob);
    process.env.PR1863_SOURCE_PIN = JSON.stringify(pin);
    process.env.PR1863_PROBE_OUTPUT = path.join(live, "probe.json");
    const probeResult = await phase("probe", ["bun", "run", destination], sourceRoot, 10 * 60_000);
    try {
      const data = JSON.parse(capture("probe.json", 4 * 1024 * 1024).toString());
      probe = verifyProbe(data, variant, probeResult, pin);
      write("probe-verification.json", probe);
      assert(data.ui && data.ui.checkpoint.ok, "No native checkpoint patch available for UI review");
      const ui = Buffer.from(JSON.stringify(data.ui, null, 2) + "\n");
      assert(ui.length <= 32 * 1024);
      writeFileSync(path.join(frozen, "ui-payload.json"), ui, { flag: "wx", mode: 0o444 });
      console.log("SYNARA_PR1863_UI " + JSON.stringify({
        source: pin, platform: process.platform, bytes: ui.length, sha256: hash(ui), gitBlob: blob(ui), base64: ui.toString("base64"),
      }));
    } catch (error) { failures.push({ phase: "probe-verification", ...recordError(error) }); }
  } catch (error) { failures.push({ phase: "setup", ...recordError(error) }); }
  finally {
    for (const [relative, expected] of extras) {
      try {
        const file = path.join(sourceRoot, relative);
        assert.equal(blob(readFileSync(file)), expected, "Refuse deleting a changed probe");
        unlinkSync(file);
      } catch (error) { failures.push({ phase: "remove-probe", path: relative, ...recordError(error) }); }
    }
    for (const [relative, entry] of overlays) {
      try {
        const file = path.join(sourceRoot, relative);
        assert.equal(blob(readFileSync(file)), entry.sha, "Refuse restoring a changed fixture");
        writeFileSync(file, entry.original);
      } catch (error) { failures.push({ phase: "restore-fixture", path: relative, ...recordError(error) }); }
    }
    try { write("source-restored.json", sourceProof(sourceRoot, pin, new Map(), new Map(), "restored")); }
    catch (error) { failures.push({ phase: "source-restored", ...recordError(error) }); }
    const actualCodes = phases.map((entry) => entry.result?.observerStatus ?? 1);
    const exitCode = failures.length || actualCodes.some((code) => code !== 0) ? 1 : 0;
    write("result.json", { variant, source: pin, failures, phases, tests, probe, exitCode,
      verificationPassed: failures.length === 0, expectedFailuresNeverConvertedToJobSuccess: true,
      descendantExitProven: false });
    const files = readdirSync(frozen).sort().map((relative) => {
      const file = path.join(frozen, relative), stat = lstatSync(file);
      assert(!relative.startsWith(".") && stat.isFile() && !stat.isSymbolicLink());
      const bytes = readFileSync(file);
      return { path: relative, bytes: bytes.length, sha256: hash(bytes), gitBlob: blob(bytes) };
    });
    write("manifest.json", { schemaVersion: 1, source: pin, driverHead: process.env.GITHUB_SHA,
      platform: process.platform, files });
    console.log("SYNARA_PR1863_RESULT " + JSON.stringify({ variant, source: pin.sha, platform: process.platform,
      exitCode, verificationPassed: failures.length === 0, tests, failures }));
    process.exitCode = exitCode;
  }
}

await main();

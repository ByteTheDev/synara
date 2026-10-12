import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
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
  ".github/workflows/pr619-profile-qualification.yml",
  "scripts/pr619-profile-qualification/README.md",
  "scripts/pr619-profile-qualification/pins.json",
  "scripts/pr619-profile-qualification/runner.mjs",
  "scripts/pr619-profile-qualification/owned-command-observer.mjs",
];

function safeRelative(relative) {
  assert(typeof relative === "string" && relative && !path.isAbsolute(relative));
  assert(relative.split(/[\\/]/).every((part) => part && part !== "." && part !== ".."));
  return relative;
}

function driverProof() {
  assert.equal(driverRoot, path.join(process.env.GITHUB_WORKSPACE, "driver"));
  assert.equal(git(driverRoot, "rev-parse", "HEAD").toString().trim(), process.env.GITHUB_SHA);
  return driverPaths.map((relative) => {
    const file = path.join(driverRoot, relative);
    assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
    const bytes = readFileSync(file);
    assert(bytes.equals(git(driverRoot, "show", "HEAD:" + relative)), "Driver bytes changed");
    return { path: relative, bytes: bytes.length, gitBlob: blob(bytes), sha256: hash(bytes) };
  });
}

function sourceProof(root, stage) {
  assert.equal(git(root, "rev-parse", "HEAD").toString().trim(), pins.source.sha);
  assert.equal(git(root, "rev-parse", "HEAD^{tree}").toString().trim(), pins.source.tree);
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
    const file = path.join(root, relative), stat = lstatSync(file);
    assert(stat.isFile() && !stat.isSymbolicLink(), "Non-regular source: " + relative);
    assert.equal((stat.mode & 0o111) !== 0, mode === "100755", relative);
    assert.equal(blob(readFileSync(file)), sha, relative);
    count++;
  }
  assert.equal(count, pins.source.files);
  assert.equal(index.size, pins.source.files);
  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all").length, 0, "Source status changed");
  assert.equal(git(root, "diff", "--name-only", "HEAD", "--").length, 0);
  for (const row of pins.commandSources) assert.equal(blob(readFileSync(path.join(root, row.path))), row.sha, row.path);
  return { stage, at: now(), head: pins.source.sha, tree: pins.source.tree, trackedFiles: count,
    listingSha256: hash(listing), rawBytesAndIndexModesVerified: true, filesystemExecutableBitsChecked: true,
    sourceStatusEmpty: true, overlays: [],
    qualification: "Every tracked byte and index/filesystem mode is checked. Git-ignored dependency and generator caches are not product source." };
}

function snapshot(live, destination, cap, mode = 0o444) {
  assert(Number.isSafeInteger(cap) && cap >= 0, "Invalid evidence cap");
  const startedAt = now();
  if (!existsSync(live)) return { missing: true, startedAt, completedAt: now() };
  const initialPath = lstatSync(live);
  assert(initialPath.isFile() && !initialPath.isSymbolicLink(), "Non-regular live evidence");
  const fd = openSync(live, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let bytes;
  let receipt;
  try {
    const before = fstatSync(fd);
    const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
    assert(before.isFile() && sameIdentity(before, initialPath), "Evidence identity changed before read");
    assert(Number.isSafeInteger(before.size) && before.size >= 0, "Invalid evidence size");
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
      changed: !after.isFile() || !finalPath.isFile() || finalPath.isSymbolicLink() ||
        !sameIdentity(before, after) || !sameIdentity(before, finalPath) ||
        before.size !== after.size || before.size !== finalPath.size ||
        before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        before.mtimeMs !== finalPath.mtimeMs || before.ctimeMs !== finalPath.ctimeMs,
      sha256: hash(bytes), gitBlob: blob(bytes),
      qualification: "One fixed descriptor read. Only this copied prefix is uploaded; later live writes cannot alter it.",
    };
  } finally { closeSync(fd); }
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, bytes, { flag: "wx", mode });
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

function observeReport(report, spec, sourceRoot) {
  assert(Array.isArray(report.testResults));
  const suites = report.testResults.map((suite) => ({
    path: path.relative(sourceRoot, path.resolve(suite.name)).split(path.sep).join("/"),
    status: suite.status,
    assertions: suite.assertionResults.map((entry) => ({
      title: entry.title, fullName: entry.fullName, status: entry.status,
      failureMessages: entry.failureMessages ?? [],
    })),
  }));
  return {
    success: report.success,
    totals: { passed: report.numPassedTests, failed: report.numFailedTests,
      pending: report.numPendingTests, todo: report.numTodoTests, total: report.numTotalTests },
    suites,
    skipped: suites.flatMap((suite) => suite.assertions.filter((entry) => ["pending", "skipped"].includes(entry.status))
      .map((entry) => ({ path: suite.path, title: entry.title }))),
    qualification: "Complete pinned files run without a test-name filter. Only the original explicit CI/native-CLI skips named in pins.json are permitted; they do not count as executed tests.",
  };
}

function verifyReport(observation, spec, result) {
  completeRoot(result, 0);
  const expected = spec.suites.map((row) => row.path).sort();
  assert.deepEqual(observation.suites.map((row) => row.path).sort(), expected);
  assert.equal(observation.success, true);
  assert(observation.suites.every((suite) => suite.status === "passed" && suite.assertions.length > 0));
  const all = observation.suites.flatMap((suite) => suite.assertions);
  const sortRows = (rows) => rows.toSorted((a, b) => (a.path + "\0" + a.title).localeCompare(b.path + "\0" + b.title));
  assert.deepEqual(sortRows(observation.skipped), sortRows(spec.originalSkips ?? []));
  assert(all.every((entry) => ["passed", "pending", "skipped"].includes(entry.status)));
  assert.equal(observation.totals.failed, 0);
  assert.equal(observation.totals.todo, 0);
  assert.equal(observation.totals.pending, observation.skipped.length);
  assert.equal(observation.totals.passed, all.filter((entry) => entry.status === "passed").length);
  assert.equal(observation.totals.total, all.length);
  assert.equal(observation.totals.passed + observation.totals.pending, all.length);
}

async function main() {
  const lane = process.argv[2];
  assert(Object.hasOwn(pins.lanes, lane));
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_WORKSPACE && process.env.GITHUB_SHA);
  assert.equal(process.platform, "linux");
  const spec = pins.lanes[lane];
  const sourceRoot = path.join(process.env.GITHUB_WORKSPACE, "source");
  const root = path.join(process.env.RUNNER_TEMP, "pr619-profile-" + lane);
  assert(!existsSync(root), "Refuse reused diagnostic output");
  const live = path.join(root, "live"), frozen = path.join(root, "frozen");
  mkdirSync(live, { recursive: true });
  mkdirSync(frozen);
  const write = (name, value) => {
    const target = path.join(frozen, safeRelative(name));
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  };
  const failures = [], phases = [];
  let testObservation = null, testVerificationPassed = null, formatterProposal = null;
  const capture = (filename, cap = 64 * 1024 * 1024) => {
    const receipt = snapshot(path.join(live, safeRelative(filename)), path.join(frozen, filename), cap);
    write(filename + ".snapshot.json", receipt);
    assert(!receipt.missing && !receipt.capped && !receipt.shortRead && !receipt.changed,
      "Incomplete fixed snapshot: " + filename);
    return readFileSync(path.join(frozen, filename));
  };
  const phase = async (name, command, cwd, deadlineMs) => {
    let result = null;
    try {
      write("source-before-" + name + ".json", sourceProof(sourceRoot, "before-" + name));
      result = await observeCommand({ command, cwd, deadlineMs, drainMs: 10_000,
        capBytes: 64 * 1024 * 1024, logPath: path.join(live, name + ".log") });
      write(name + ".process.json", result);
    } catch (error) { failures.push({ phase: name, ...recordError(error) }); }
    finally {
      try { capture(name + ".log"); }
      catch (error) { failures.push({ phase: name + "-snapshot", ...recordError(error) }); }
      try { write("source-after-" + name + ".json", sourceProof(sourceRoot, "after-" + name)); }
      catch (error) { failures.push({ phase: name + "-source", ...recordError(error) }); }
      phases.push({ name, result });
    }
    return result;
  };
  const check = async (name, command, deadline) => {
    const result = await phase(name, command, sourceRoot, deadline);
    try { completeRoot(result, 0); }
    catch (error) { failures.push({ phase: name + "-verification", ...recordError(error) }); }
    return result;
  };
  const proposeFormatting = async () => {
    const inputs = [];
    for (const row of pins.formatPaths) {
      assert(row.bytes <= 4 * 1024 * 1024);
      const relative = safeRelative(row.path), target = path.join(live, "formatted-source", relative);
      const receipt = snapshot(path.join(sourceRoot, relative), target, 4 * 1024 * 1024, 0o600);
      write("format-input/" + relative + ".json", receipt);
      assert(!receipt.missing && !receipt.capped && !receipt.shortRead && !receipt.changed);
      assert.equal(receipt.gitBlob, row.sha);
      assert.equal(receipt.capturedBytes, row.bytes);
      inputs.push({ ...row, path: relative, copy: target });
    }
    const formatted = await check("format-copy", [
      "bun", "run", "fmt", "--config", path.join(sourceRoot, ".oxfmtrc.json"),
      ...inputs.map((row) => row.copy),
    ], 5 * 60_000);
    const copies = [];
    for (const row of inputs) {
      try {
        const bytes = capture("formatted-source/" + row.path, 4 * 1024 * 1024);
        copies.push({ path: row.path, originalBlob: row.sha, bytes: bytes.length,
          sha256: hash(bytes), gitBlob: blob(bytes), changed: blob(bytes) !== row.sha });
      } catch (error) { failures.push({ phase: "formatted-copy", path: row.path, ...recordError(error) }); }
    }
    formatterProposal = { formatterResult: formatted, copies,
      qualification: "Actual formatter output on separately owned copies, retained for source review only. Original fmt:check failure remains failed. No product source is formatted or replaced." };
    write("formatter-proposal.json", formatterProposal);
  };
  try {
    const prerequisites = {
      bunSetup: process.env.PR619_BUN_OUTCOME, nodeSetup: process.env.PR619_NODE_OUTCOME,
      syntax: process.env.PR619_SYNTAX_OUTCOME,
    };
    write("provenance.json", {
      lane, source: pins.source, originalAuthorHead: pins.originalAuthorHead, currentMain: pins.currentMain,
      driverHead: process.env.GITHUB_SHA, driver: driverProof(), prerequisites,
      environment: { platform: process.platform, architecture: process.arch, node: process.version,
        electronSkip: process.env.ELECTRON_SKIP_BINARY_DOWNLOAD, ci: process.env.CI },
      exactInstallCommand: pins.installCommand, qualification: pins.qualification,
      fullRootStaticChecksUseOnlyProductCheckout: true,
    });
    write("source-initial.json", sourceProof(sourceRoot, "initial"));
    assert(Object.values(prerequisites).every((value) => value === "success"), "A prerequisite action failed or did not run");
    assert.equal(execFileSync("bun", ["--version"], { timeout: 10_000 }).toString().trim(), pins.bunVersion);
    assert.equal(process.env.ELECTRON_SKIP_BINARY_DOWNLOAD, "1");
    assert(process.env.CI && !process.env.CODEX_BINARY_PATH, "Preserve original hosted integration skip gates");
    assert.deepEqual(pins.installCommand, ["bun", "install", "--frozen-lockfile", "--concurrent-scripts=1"]);
    const installed = await phase("install", pins.installCommand, sourceRoot, 20 * 60_000);
    completeRoot(installed, 0);
    if (lane === "static") {
      await check("types", ["bun", "run", "typecheck"], 25 * 60_000);
      const format = await check("format", ["bun", "run", "fmt:check"], 5 * 60_000);
      if (format && format.observerStatus !== 0) {
        try { await proposeFormatting(); }
        catch (error) { failures.push({ phase: "format-proposal", ...recordError(error) }); }
      }
      await check("lint", ["bun", "run", "lint"], 10 * 60_000);
      await check("sync-fs", ["bun", "run", "server-sync-fs:check"], 3 * 60_000);
    } else {
      assert(spec.suites.length > 0);
      for (const row of spec.suites) {
        assert.equal(blob(readFileSync(path.join(sourceRoot, safeRelative(row.path)))), row.sha);
        assert(row.path.startsWith(spec.cwd + "/"));
      }
      const command = ["bun", "run", "test", "--",
        ...spec.suites.map((row) => row.path.slice(spec.cwd.length + 1)),
        "--reporter=verbose", "--reporter=json", "--outputFile=" + path.join(live, "tests.json")];
      const testResult = await phase("tests", command, path.join(sourceRoot, spec.cwd), 45 * 60_000);
      try {
        const raw = JSON.parse(capture("tests.json").toString());
        testObservation = observeReport(raw, spec, sourceRoot);
        write("test-observation.json", testObservation);
        verifyReport(testObservation, spec, testResult);
        testVerificationPassed = true;
      } catch (error) {
        testVerificationPassed = false;
        failures.push({ phase: "test-verification", ...recordError(error) });
      }
    }
  } catch (error) { failures.push({ phase: "prerequisite-or-install", ...recordError(error) }); }
  finally {
    try { write("source-final.json", sourceProof(sourceRoot, "final")); }
    catch (error) { failures.push({ phase: "final-source", ...recordError(error) }); }
    try { write("driver-final.json", driverProof()); }
    catch (error) { failures.push({ phase: "final-driver", ...recordError(error) }); }
    const exitCode = failures.length || phases.some((entry) => entry.result?.observerStatus !== 0) ? 1 : 0;
    write("result.json", {
      lane, source: pins.source, failures, phases, testObservation, testVerificationPassed,
      formatterProposal, exitCode, verificationPassed: failures.length === 0,
      productTestsPassed: lane !== "static" && testVerificationPassed === true && failures.length === 0,
      rawNonzeroCommandsNeverConvertedToSuccess: true, descendantExitProven: false,
      qualification: "Single-source qualification only. Source publication, full canonical CI, browser/native product flows and named-profile execution support are separate gates.",
    });
    const inventory = (relative = "") => readdirSync(path.join(frozen, relative)).sort().flatMap((name) => {
      const filename = relative ? relative + "/" + name : name, file = path.join(frozen, filename);
      const stat = lstatSync(file);
      assert(!stat.isSymbolicLink(), "No symbolic links in fixed evidence");
      if (stat.isDirectory()) return inventory(filename);
      assert(stat.isFile(), "Only regular frozen evidence is exported");
      const bytes = readFileSync(file);
      return [{ path: filename, bytes: bytes.length, sha256: hash(bytes), gitBlob: blob(bytes) }];
    });
    write("manifest.json", { schemaVersion: 1, lane, source: pins.source,
      driverHead: process.env.GITHUB_SHA, capturedAt: now(), files: inventory() });
    const failed = testObservation?.suites.flatMap((suite) => suite.assertions.filter((entry) => entry.status === "failed")
      .map((entry) => ({ path: suite.path, title: entry.title, messages: entry.failureMessages }))) ?? [];
    const consoleFailures = failed.slice(0, 20).map((entry) => ({ ...entry,
      messages: entry.messages.map((message) => message.slice(0, 4096)),
      messageCut: entry.messages.some((message) => message.length > 4096),
    }));
    console.log("SYNARA_PR619_RESULT " + JSON.stringify({
      lane, source: pins.source.sha, exitCode, verificationPassed: failures.length === 0,
      phases: phases.map((entry) => ({ name: entry.name, result: entry.result })),
      totals: testObservation?.totals ?? null, skipped: testObservation?.skipped ?? [],
      failures, failedAssertionsPreview: consoleFailures, failedAssertionsTotal: failed.length,
      fullFailureMessagesRetainedInFrozenReport: true,
      formattedChanges: formatterProposal?.copies.filter((row) => row.changed) ?? [],
    }));
    process.exitCode = exitCode;
  }
}

await main();

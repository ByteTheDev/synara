import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, readlinkSync, readSync, readdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

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
const driverPaths = [
  ".github/workflows/pr1866-projection-evidence.yml",
  "scripts/pr1866-projection-evidence/README.md",
  "scripts/pr1866-projection-evidence/pins.json",
  "scripts/pr1866-projection-evidence/runner.mjs",
  "scripts/pr1866-projection-evidence/owned-command-observer.mjs",
  "scripts/pr1866-projection-evidence/backend-fixture.ts",
  "scripts/pr1866-projection-evidence/append-fixture.tsx",
  "scripts/pr1866-projection-evidence/vitest.pr1866-projection-evidence.config.ts",
];
const configRelative = "apps/web/vitest.pr1866-projection-evidence.config.ts";
const payloadRelative = "apps/web/src/reconciliationEvidence.generated.json";
const backendRelative = "apps/server/" + pins.backendSuite;
const driverRelative = ".runtime-reconciliation-ui-driver";
const browserLiveRelative = "runtime-reconciliation-evidence-live";

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
    assert(lstatSync(file).isFile(), "Driver path must be regular: " + relative);
    const bytes = readFileSync(file);
    assert(bytes.equals(git(driverRoot, "show", "HEAD:" + relative)),
      "Driver bytes changed: " + relative);
    return metadata(relative, bytes);
  });
}
function sourceProof(root, pin, overlays, created, side, stage) {
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
    assert(lstatSync(file).isFile(), "Owned fixture must remain regular: " + relative);
    const bytes = readFileSync(file);
    assert.equal(bytes.length, receipt.bytes, relative);
    assert.equal(gitBlob(bytes), receipt.gitBlob, relative);
  }
  const status = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    .toString().split("\0").filter(Boolean);
  for (const entry of status) {
    const code = entry.slice(0, 2);
    const relative = entry.slice(3);
    if (overlays.has(relative)) {
      assert.equal(code, " M", "Only the declared unstaged harness overlay is allowed.");
    } else {
      assert.equal(code, "??", "Unexpected tracked status: " + entry);
      assert(created.has(relative) ||
        relative === driverRelative + "/" ||
        relative.startsWith(driverRelative + "/") ||
        relative.startsWith(browserLiveRelative + "/" + side + "/"),
        "Unexpected untracked source: " + entry);
    }
  }
  assert.equal(gitBlob(readFileSync(path.join(root,
    ".github/actions/setup-workspace/action.yml"))), pins.setupWorkspaceBlob);
  assert.equal(gitBlob(readFileSync(path.join(root, pins.browser.productionPath))),
    pins.browser.productionBlob);
  assert.equal(gitBlob(readFileSync(path.join(root, pins.browser.canonicalPath))),
    pins.browser.canonicalBlob);
  return {
    stage, at: now(), head: pin.sha, tree: pin.tree, trackedFiles: count,
    listingSha256: digest(listing), rawTrackedBytesAndModesVerified: true, status,
    overlays: [...overlays.values()].map(({ original, ...receipt }) => receipt),
    addedFixtures: [...created.values()],
    qualification: "All tracked bytes, modes, HEAD and staged/unstaged differences checked. Only exact declared harness/new-fixture paths, this side's live media, and the separately verified driver checkout may appear in Git status; ignored dependency caches are not claimed as source.",
  };
}
function walkFiles(root, prefix = "") {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)).flatMap((entry) => {
    assert(!entry.name.startsWith("."), "Hidden evidence must not be silently omitted.");
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    const file = path.join(root, entry.name);
    assert(!entry.isSymbolicLink(), "Evidence symlinks are refused: " + relative);
    if (entry.isDirectory()) return walkFiles(file, relative);
    assert(entry.isFile(), "Only regular evidence is accepted: " + relative);
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
function verifyReport(report, result, absoluteSuite, name, allowUnselected) {
  completeRoot(result);
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPassedTests, 1);
  assert(Array.isArray(report.testResults) && report.testResults.length === 1);
  assert.equal(path.resolve(report.testResults[0].name), absoluteSuite);
  const assertions = report.testResults[0].assertionResults;
  const selected = assertions.filter((entry) => entry.title === name);
  assert.equal(selected.length, 1, "Exactly one selected diagnostic case must execute.");
  assert.equal(selected[0].status, "passed");
  const others = assertions.filter((entry) => entry !== selected[0]);
  if (!allowUnselected) {
    assert.equal(others.length, 0);
    assert.equal(report.numPendingTests, 0);
    assert.equal(report.numTodoTests, 0);
  } else {
    assert(others.every((entry) => ["pending", "skipped", "todo"].includes(entry.status)),
      "Original canonical cases are unselected here; no unexpected case may execute.");
  }
  return {
    selected: selected.map((entry) => ({
      title: entry.title, fullName: entry.fullName, status: entry.status,
      failureMessages: entry.failureMessages ?? [],
    })),
    passed: report.numPassedTests, failed: report.numFailedTests,
    pending: report.numPendingTests, todo: report.numTodoTests,
    unselectedCanonicalCases: others.length,
  };
}
function verifyProjection(payload, side, pin) {
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.side, side);
  assert.equal(payload.source, pin.sha);
  assert.equal(payload.driver, process.env.GITHUB_SHA);
  assert.equal(payload.threadId, "lifecycle-thread");
  assert.equal(payload.reconciliationObservationOffsetMs, 46 * 60_000);
  assert.equal(payload.realAdapterAndWatchdogClock, true);
  assert.equal(payload.actualNativeTurnIdBefore, "fixture-turn-1");
  assert.equal(payload.actualNativeTurnIdAfter, "fixture-turn-1");
  assert.deepEqual(payload.protocol, [{ type: "started", turnId: "fixture-turn-1" }]);
  assert.deepEqual(payload.observations.map((row) => row.stage), ["live", "reconciled"]);
  for (const observation of payload.observations) {
    const snapshot = observation.snapshot;
    assert.equal(snapshot.threads.length, 1);
    assert.equal(snapshot.projects.length, 1);
    const thread = snapshot.threads[0];
    assert.equal(thread.id, payload.threadId);
    assert(thread.messages.some((row) => row.text.includes("Working on fixture-turn-1")));
    const running = observation.stage === "live" || side === "after";
    assert.equal(thread.session.status, running ? "running" : "interrupted");
    assert.equal(thread.latestTurn.state, running ? "running" : "interrupted");
    assert.equal(thread.session.activeTurnId, running ? "fixture-turn-1" : null);
    assert.equal(thread.latestTurn.completedAt === null, running);
    assert(Number.isFinite(Date.parse(observation.capturedAt)));
    assert(Number.isSafeInteger(snapshot.snapshotSequence));
  }
  assert(payload.observations[1].snapshot.snapshotSequence >=
    payload.observations[0].snapshot.snapshotSequence);
  return payload;
}
function verifyPng(bytes) {
  assert(bytes.length > 1024 && bytes.length <= 16 * 1024 * 1024);
  assert(bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  let offset = 8;
  let header = null;
  let ended = false;
  const compressed = [];
  while (offset < bytes.length) {
    assert(offset + 12 <= bytes.length);
    const length = bytes.readUInt32BE(offset);
    assert(offset + 12 + length <= bytes.length);
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(crc32(bytes.subarray(offset + 4, offset + 8 + length)),
      bytes.readUInt32BE(offset + 8 + length), "PNG chunk CRC");
    if (offset === 8) {
      assert.equal(type, "IHDR"); assert.equal(length, 13);
      header = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9] };
      assert.deepEqual([header.width, header.height, header.depth], [960, 1100, 8]);
      assert([2, 6].includes(header.color));
      assert.deepEqual([...data.subarray(10)], [0, 0, 0]);
    }
    if (type === "IDAT") compressed.push(data);
    if (type === "IEND") {
      assert.equal(length, 0); ended = true;
      assert.equal(offset + 12, bytes.length);
    }
    offset += 12 + length;
  }
  assert(ended && header && compressed.length > 0);
  const rowBytes = header.width * (header.color === 6 ? 4 : 3) + 1;
  const decoded = inflateSync(Buffer.concat(compressed), { maxOutputLength: rowBytes * header.height });
  assert.equal(decoded.length, rowBytes * header.height);
  for (let row = 0; row < header.height; row++) assert(decoded[row * rowBytes] <= 4);
  return { width: header.width, height: header.height, chunkCrcsVerified: true, decodedBytes: decoded.length };
}
async function main() {
  const side = process.argv[2];
  assert(["before", "after"].includes(side));
  assert.equal(process.platform, "linux");
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_WORKSPACE && process.env.GITHUB_SHA);
  const sourceRoot = path.resolve(process.env.GITHUB_WORKSPACE);
  assert.equal(path.relative(sourceRoot, driverRoot), driverRelative);
  const pin = side === "before" ? pins.before : pins.candidate;
  const root = path.join(process.env.RUNNER_TEMP, "pr1866-projection-" + side);
  const live = path.join(root, "live");
  const frozen = path.join(root, "frozen");
  const backendOutput = path.join(live, "backend");
  const browserOutput = path.join(sourceRoot, browserLiveRelative, side);
  assert(!existsSync(root) && !existsSync(browserOutput), "Refuse reused diagnostic output.");
  mkdirSync(backendOutput, { recursive: true });
  mkdirSync(browserOutput, { recursive: true });
  mkdirSync(frozen);
  const failures = [];
  const phases = [];
  const snapshots = [];
  const overlays = new Map();
  const created = new Map();
  const writeJson = (relative, value) => {
    const file = path.join(frozen, safeRelative(relative));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  };
  const attempt = (phaseName, callback) => {
    try { return callback(); }
    catch (error) { failures.push({ phase: phaseName, ...recordError(error) }); return null; }
  };
  const capture = (source, relative, cap = 32 * 1024 * 1024) => {
    safeRelative(relative);
    const receipt = snapshotFile(source, path.join(frozen, relative), relative, cap);
    snapshots.push(receipt);
    assert(!receipt.missing && !receipt.possibleTail, "Incomplete fixed snapshot: " + relative);
    return receipt;
  };
  const proof = (stage) => sourceProof(sourceRoot, pin, overlays, created, side, stage);
  const phase = async (name, command, cwd, deadlineMs, extraEnvironment = {}) => {
    let result = null;
    try {
      writeJson("source-before-" + name + ".json", proof("before-" + name));
      result = await observeCommand({
        command, cwd, deadlineMs, drainMs: 10_000, capBytes: 32 * 1024 * 1024,
        logPath: path.join(live, name + ".log"),
        spawnChild: (commandName, args, options) => spawn(commandName, args, {
          ...options, env: { ...options.env, ...extraEnvironment },
        }),
      });
      writeJson(name + "-process.json", result);
    } catch (error) { failures.push({ phase: name, ...recordError(error) }); }
    finally {
      attempt(name + "-log-snapshot", () =>
        capture(path.join(live, name + ".log"), name + ".log"));
      attempt(name + "-source", () =>
        writeJson("source-after-" + name + ".json", proof("after-" + name)));
      phases.push({ name, result });
    }
    return result;
  };
  const addOwned = (relative, bytes) => {
    safeRelative(relative);
    const file = path.join(sourceRoot, relative);
    assert(!existsSync(file), "Refuse replacing an existing fixture: " + relative);
    writeFileSync(file, bytes, { flag: "wx" });
    created.set(relative, metadata(relative, bytes));
  };
  let driverBefore = null;
  let backendVerification = null;
  let browserVerification = null;
  let projection = null;
  let mediaFrozen = false;
  const freezeMedia = () => {
    if (mediaFrozen) return;
    mediaFrozen = true;
    for (const relative of walkFiles(browserOutput)) {
      assert(relative === "00-live.png" || relative === "01-reconciled.png" ||
        /^video\/[^/]+\.webm$/.test(relative), "Unexpected browser evidence: " + relative);
      capture(path.join(browserOutput, relative), relative,
        relative.endsWith(".webm") ? 128 * 1024 * 1024 : 16 * 1024 * 1024);
    }
  };
  try {
    driverBefore = verifyDriver();
    writeJson("provenance.json", {
      schemaVersion: 1, side, source: pin, before: pins.before, candidate: pins.candidate,
      driverHead: process.env.GITHUB_SHA, driver: driverBefore,
      environment: { platform: process.platform, architecture: process.arch, node: process.version },
      qualification: pins.qualification,
    });
    writeJson("source-before-overlay.json", proof("before-overlay"));
    for (const fixture of pins.fixtures) {
      const bytes = git(driverRoot, "show", "HEAD:" + fixture.path);
      assert.equal(bytes.length, fixture.bytes);
      assert.equal(gitBlob(bytes), fixture.sha);
      const file = path.join(sourceRoot, fixture.path);
      if (!existsSync(file)) addOwned(fixture.path, bytes);
      else {
        const original = readFileSync(file);
        if (!original.equals(bytes)) {
          assert.equal(side, "before");
          assert.equal(fixture.path, "apps/server/integration/OrchestrationEngineHarness.integration.ts");
          overlays.set(fixture.path, { ...metadata(fixture.path, bytes), original });
          writeFileSync(file, bytes);
        }
      }
    }
    addOwned(backendRelative, readFileSync(path.join(directory, "backend-fixture.ts")));
    writeJson("source-after-backend-overlay.json", proof("after-backend-overlay"));
    const backend = await phase("backend", [
      "bunx", "vitest", "run", "--maxWorkers=1", "--no-file-parallelism",
      "--reporter=verbose", "--reporter=json",
      "--outputFile=" + path.join(live, "backend.json"), pins.backendSuite,
    ], path.join(sourceRoot, "apps/server"), 10 * 60_000, {
      SYNARA_RECONCILIATION_SIDE: side, SYNARA_RECONCILIATION_SOURCE: pin.sha,
      SYNARA_RECONCILIATION_OUTPUT: backendOutput,
    });
    capture(path.join(live, "backend.json"), "backend.json");
    backendVerification = verifyReport(JSON.parse(readFileSync(path.join(frozen, "backend.json"), "utf8")),
      backend, path.join(sourceRoot, backendRelative), pins.backendName, false);
    writeJson("backend-verification.json", backendVerification);
    capture(path.join(backendOutput, "projection.json"), "projection.json", 8 * 1024 * 1024);
    const projectionBytes = readFileSync(path.join(frozen, "projection.json"));
    projection = verifyProjection(JSON.parse(projectionBytes.toString("utf8")), side, pin);

    const canonical = readFileSync(path.join(sourceRoot, pins.browser.canonicalPath));
    assert.equal(canonical.length, pins.browser.canonicalBytes);
    assert.equal(gitBlob(canonical), pins.browser.canonicalBlob);
    assert(canonical.toString("utf8").endsWith("});\n"));
    const append = readFileSync(path.join(directory, "append-fixture.tsx"), "utf8");
    const composite = Buffer.from(pins.browser.prefix +
      canonical.toString("utf8").slice(0, -4) + append + "\n});\n");
    assert.equal(composite.length, pins.browser.overlayBytes);
    assert.equal(gitBlob(composite), pins.browser.overlayBlob);
    const reversed = Buffer.from(composite.toString("utf8").slice(pins.browser.prefix.length,
      -(append.length + "\n});\n".length)) + "});\n");
    assert(reversed.equals(canonical), "Every original canonical fixture byte must be preserved.");
    assert.equal(gitBlob(Buffer.from(pins.browser.prefix)), pins.browser.prefixBlob);
    addOwned(pins.browser.overlayPath, composite);
    addOwned(payloadRelative, projectionBytes);
    addOwned(configRelative, readFileSync(path.join(directory,
      "vitest.pr1866-projection-evidence.config.ts")));
    writeJson("fixture-overlays.json", {
      backend: created.get(backendRelative), browser: created.get(pins.browser.overlayPath),
      exactBackendPayload: created.get(payloadRelative), config: created.get(configRelative),
      canonical: metadata(pins.browser.canonicalPath, canonical), originalCanonicalBytesReversed: true,
    });
    const browser = await phase("browser", [
      "bunx", "vitest", "run", "--config", path.basename(configRelative),
      "--reporter=verbose", "--reporter=json", "--outputFile=" + path.join(live, "browser.json"),
    ], path.join(sourceRoot, "apps/web"), 15 * 60_000, {
      VITE_PR1866_SIDE: side, VITE_PR1866_SOURCE: pin.sha, VITE_PR1866_OUTPUT: browserOutput,
    });
    attempt("media-snapshots", freezeMedia);
    capture(path.join(live, "browser.json"), "browser.json");
    browserVerification = verifyReport(JSON.parse(readFileSync(path.join(frozen, "browser.json"), "utf8")),
      browser, path.join(sourceRoot, pins.browser.overlayPath), pins.browserName, true);
    writeJson("browser-verification.json", browserVerification);

    const log = readFileSync(path.join(frozen, "browser.log"), "utf8").replace(/\u001b\[[0-9;]*m/g, "");
    const prefix = "PR1866_UI_OBSERVATION ";
    const observations = log.split("\n").filter((line) => line.includes(prefix))
      .map((line) => JSON.parse(line.slice(line.indexOf(prefix) + prefix.length)));
    assert.deepEqual(observations.map((row) => row.stage), ["live", "reconciled"]);
    for (const [index, row] of observations.entries()) {
      const snapshot = projection.observations[index].snapshot;
      const thread = snapshot.threads[0];
      assert.equal(row.side, side); assert.equal(row.source, pin.sha);
      assert.equal(row.driver, process.env.GITHUB_SHA);
      assert.equal(row.projectedSequence, snapshot.snapshotSequence);
      assert.equal(row.projectedSessionStatus, thread.session.status);
      assert.equal(row.projectedTurnState, thread.latestTurn.state);
      assert.equal(row.projectedActiveTurnId, thread.session.activeTurnId);
      assert.equal(row.projectedCompletedAt, thread.latestTurn.completedAt);
      assert.equal(row.actualNativeTurnId, "fixture-turn-1");
      assert.deepEqual(row.viewport, { width: 960, height: 1100 });
      assert.equal(row.mountedRoute, "/" + projection.threadId);
      assert(row.visibleText.includes("Working on fixture-turn-1"));
      if (index === 0 || side === "after") assert.match(row.liveHeaderText, /^Working for \d/);
      else assert.equal(row.liveHeaderText, null);
    }
    writeJson("ui-observations.json", observations);
    const pngs = walkFiles(frozen).filter((relative) => relative.endsWith(".png"));
    assert.deepEqual(pngs.sort(), ["00-live.png", "01-reconciled.png"]);
    writeJson("png-verification.json", pngs.map((relative) => ({
      file: relative, ...verifyPng(readFileSync(path.join(frozen, relative))),
    })));
    const videos = walkFiles(frozen).filter((relative) => /^video\/[^/]+\.webm$/.test(relative));
    assert.equal(videos.length, 1, "One actual page recording is required.");
    const video = readFileSync(path.join(frozen, videos[0]));
    assert(video.length > 1024 && video.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex")));
    const probe = await phase("video-probe", [
      "ffprobe", "-v", "error", "-show_entries",
      "format=duration:stream=codec_type,width,height,duration", "-of", "json",
      path.join(frozen, videos[0]),
    ], sourceRoot, 30_000);
    completeRoot(probe);
    const videoMetadata = JSON.parse(readFileSync(path.join(frozen, "video-probe.log"), "utf8"));
    const streams = videoMetadata.streams.filter((stream) => stream.codec_type === "video");
    assert.equal(streams.length, 1);
    assert.equal(streams[0].width, 960); assert.equal(streams[0].height, 1100);
    assert(Number.isFinite(Number(videoMetadata.format.duration)) && Number(videoMetadata.format.duration) > 0);
    writeJson("video-verification.json", { file: videos[0], metadata: videoMetadata });

    for (const workspace of ["server", "web"]) {
      const result = await phase(workspace + "-types", ["bun", "run", "typecheck"],
        path.join(sourceRoot, "apps", workspace), 10 * 60_000);
      attempt(workspace + "-types-result", () => completeRoot(result));
    }
  } catch (error) { failures.push({ phase: "validation", ...recordError(error) }); }
  finally {
    attempt("final-media-snapshots", freezeMedia);
    for (const [relative, receipt] of created) {
      attempt("remove-owned-fixture:" + relative, () => {
        const file = path.join(sourceRoot, relative);
        assert(lstatSync(file).isFile());
        assert.equal(gitBlob(readFileSync(file)), receipt.gitBlob,
          "Refuse removing an externally changed fixture.");
        unlinkSync(file);
      });
    }
    created.clear();
    for (const [relative, entry] of overlays) {
      attempt("restore-harness:" + relative, () => {
        const file = path.join(sourceRoot, relative);
        assert(lstatSync(file).isFile());
        assert.equal(gitBlob(readFileSync(file)), entry.gitBlob,
          "Refuse restoring over an externally changed overlay.");
        writeFileSync(file, entry.original);
      });
    }
    overlays.clear();
    attempt("source-restored", () => writeJson("source-restored.json", proof("restored")));
    attempt("driver-final", () => {
      const after = verifyDriver();
      assert(driverBefore); assert.deepEqual(after, driverBefore);
      writeJson("driver-final.json", { head: process.env.GITHUB_SHA, files: after });
    });
    writeJson("snapshot-captures.json", snapshots);
    const exitCode = failures.length ? 1 : 0;
    writeJson("result.json", {
      schemaVersion: 1, side, source: pin, driverHead: process.env.GITHUB_SHA,
      failures, phases, backendVerification, browserVerification, exitCode,
      verificationPassed: failures.length === 0,
      descendantExitProven: false, qualification: pins.qualification,
    });
    writeJson("manifest.json", {
      schemaVersion: 1, side, source: pin, driverHead: process.env.GITHUB_SHA, capturedAt: now(),
      files: walkFiles(frozen).map((relative) => metadata(relative, readFileSync(path.join(frozen, relative)))),
    });
    console.log(JSON.stringify({
      side, source: pin.sha, driver: process.env.GITHUB_SHA, exitCode,
      verificationPassed: failures.length === 0,
      backend: backendVerification, browser: browserVerification, failures,
    }));
    process.exitCode = exitCode;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

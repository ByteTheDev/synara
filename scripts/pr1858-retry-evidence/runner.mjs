import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const driverRoot = path.resolve(directory, "../..");
const targets = JSON.parse(readFileSync(path.join(directory, "targets.json"), "utf8"));
const phase = process.argv[2];
const digest = (data) => createHash("sha256").update(data).digest("hex");
const gitBlob = (data) =>
  createHash("sha1")
    .update(Buffer.from("blob " + data.length + "\0"))
    .update(data)
    .digest("hex");
const fixtureRelative = "apps/web/src/components/ChatView.browser.tsx";
const overlayRelative = "apps/web/src/components/PrUiEvidence1858Retry.browser.tsx";
const configRelative = "apps/web/vitest.pr1858-retry-evidence.config.ts";
const driverPaths = [
  ".github/workflows/pr1858-retry-evidence.yml",
  "scripts/pr1858-retry-evidence/runner.mjs",
  "scripts/pr1858-retry-evidence/append-fixture.tsx",
  "scripts/pr1858-retry-evidence/vitest.pr1858-retry-evidence.config.ts",
  "scripts/pr1858-retry-evidence/targets.json",
  "scripts/pr1858-retry-evidence/README.md",
];
const selectedPattern = /effort retry|PR1858 review evidence/;
const captureName =
  "ChatView transcript geometry (full app) PR1858 review evidence uses the real retry menu and prior-answer pager";
const sourceRoot = process.cwd();
const target = targets.find((entry) => entry.id === process.env.PR1858_SIDE);
const output = target
  ? path.join(sourceRoot, "runtime-retry-evidence", target.id)
  : path.join(sourceRoot, "runtime-retry-evidence", "invalid-target");
const liveOutput = target
  ? path.join(sourceRoot, "runtime-retry-evidence-live", target.id)
  : path.join(sourceRoot, "runtime-retry-evidence-live", "invalid-target");
const reportPath =
  target && process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, "pr1858-retry-" + target.id, "vitest.json")
    : null;

function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      JSON.stringify({
        command: ["git", ...args],
        status: result.status,
        signal: result.signal,
        error: result.error?.message ?? null,
        stderr: result.stderr,
      }),
    );
  }
  return result.stdout;
}

function writeJson(name, value) {
  writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + "\n");
}

function fileReceipt(root, relative) {
  const full = path.join(root, relative);
  assert(lstatSync(full).isFile(), "Only regular evidence files are accepted: " + relative);
  const bytes = readFileSync(full);
  return { path: relative, bytes: bytes.length, sha256: digest(bytes), gitBlob: gitBlob(bytes) };
}

function driverReceipt() {
  const head = git(driverRoot, ["rev-parse", "HEAD"]).trim();
  assert.equal(head, process.env.GITHUB_SHA, "Driver checkout must match the workflow head.");
  git(driverRoot, ["diff", "--exit-code", "HEAD", "--"]);
  const files = driverPaths.map((relative) => {
    const receipt = fileReceipt(driverRoot, relative);
    assert.equal(
      receipt.gitBlob,
      git(driverRoot, ["rev-parse", "HEAD:" + relative]).trim(),
      "Driver bytes changed: " + relative,
    );
    return receipt;
  });
  return { head, files };
}

function sourceProof(stage) {
  assert(target, "Unknown target.");
  const head = git(sourceRoot, ["rev-parse", "HEAD"]).trim();
  const tree = git(sourceRoot, ["rev-parse", "HEAD^{tree}"]).trim();
  const entriesText = git(sourceRoot, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]);
  const entries = entriesText.split("\0").filter(Boolean);
  const mismatches = [];
  if (head !== target.source) mismatches.push("Unexpected source HEAD: " + head);
  if (tree !== target.tree) mismatches.push("Unexpected source tree: " + tree);
  if (entries.length !== target.trackedFiles) mismatches.push("Unexpected tracked-file count.");
  for (const line of entries) {
    const match = /^(\d{6}) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(line);
    assert(match, "Only tracked blobs are supported.");
    const [, mode, sha, relative] = match;
    assert(!path.isAbsolute(relative) && !relative.split("/").includes(".."));
    const full = path.join(sourceRoot, relative);
    try {
      const stat = lstatSync(full);
      let bytes;
      if (mode === "120000") {
        assert(stat.isSymbolicLink(), "Expected symbolic link.");
        bytes = Buffer.from(readlinkSync(full));
      } else {
        assert(mode === "100644" || mode === "100755", "Unexpected Git mode.");
        assert(stat.isFile(), "Expected regular source file.");
        assert.equal(Boolean(stat.mode & 0o111), mode === "100755", "Executable mode changed.");
        bytes = readFileSync(full);
      }
      if (gitBlob(bytes) !== sha) mismatches.push(relative + ": raw Git blob changed");
    } catch (error) {
      mismatches.push(relative + ": " + String(error));
    }
  }
  // This catches staged changes as well as unstaged tracked edits.
  try {
    git(sourceRoot, ["diff", "--exit-code", "HEAD", "--"]);
  } catch (error) {
    mismatches.push("Tracked diff guard: " + String(error));
  }
  const status = git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split("\n")
    .filter(Boolean);
  const allowedPrefix = "?? runtime-retry-evidence/" + target.id + "/";
  const allowedLivePrefix = "?? runtime-retry-evidence-live/" + target.id + "/";
  const unexpectedStatus = status.filter(
    (entry) =>
      !entry.startsWith(allowedPrefix) &&
      !entry.startsWith(allowedLivePrefix) &&
      entry !== "?? .pr1858-driver/",
  );
  if (unexpectedStatus.length) mismatches.push(...unexpectedStatus);
  return {
    stage,
    capturedAt: new Date().toISOString(),
    source: head,
    tree,
    trackedFiles: entries.length,
    gitTreeListingSha256: digest(entriesText),
    rawTrackedBlobsAndModesVerified: mismatches.length === 0,
    status,
    allowedUntrackedBoundary:
      "Only this job's explicit frozen evidence/live-output directories and separately Git-verified driver checkout.",
    mismatches,
  };
}

function walkFiles(root, prefix = "") {
  if (!existsSync(root)) return [];
  const result = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    assert(!entry.name.startsWith("."), "Hidden evidence entries are not exported: " + entry.name);
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    const full = path.join(root, entry.name);
    assert(!entry.isSymbolicLink(), "Evidence symlinks are not accepted: " + relative);
    if (entry.isDirectory()) result.push(...walkFiles(full, relative));
    else {
      assert(entry.isFile(), "Unexpected evidence entry: " + relative);
      result.push(relative);
    }
  }
  return result.sort();
}

function snapshotFile(source, relative, capBytes) {
  const destination = path.join(output, relative);
  assert(!existsSync(destination), "A retained snapshot cannot be overwritten: " + relative);
  assert(!path.isAbsolute(relative) && !relative.split("/").includes(".."));
  const startedAt = new Date().toISOString();
  const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(fd, { bigint: true });
    assert(initial.isFile(), "Only regular live files can be snapshotted.");
    const expectedBytes = Number(initial.size < BigInt(capBytes) ? initial.size : BigInt(capBytes));
    const bytes = Buffer.alloc(expectedBytes);
    let copied = 0;
    while (copied < expectedBytes) {
      const count = readSync(fd, bytes, copied, expectedBytes - copied, copied);
      if (count === 0) break;
      copied += count;
    }
    const final = fstatSync(fd, { bigint: true });
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, bytes.subarray(0, copied), { flag: "wx", mode: 0o444 });
    const capped = initial.size > BigInt(capBytes);
    const changedDuringCapture =
      initial.size !== final.size || initial.mtimeNs !== final.mtimeNs || initial.ino !== final.ino;
    return {
      path: relative,
      capturedFrom: source,
      captureStartedAt: startedAt,
      captureCompletedAt: new Date().toISOString(),
      observedInitialBytes: Number(initial.size),
      observedEndBytes: Number(final.size),
      capBytes,
      capturedBytes: copied,
      capped,
      changedDuringCapture,
      possibleTail: capped || copied !== expectedBytes || changedDuringCapture,
      qualification:
        "One immutable observed byte prefix. Later descendant writes are not silently incorporated; actual root exits and successful format parsing remain separate requirements.",
      ...fileReceipt(output, relative),
    };
  } finally {
    closeSync(fd);
  }
}

function prepare() {
  assert(target, "Select before or after explicitly.");
  assert.equal(process.env.PR1858_SOURCE, target.source);
  assert.equal(
    path.relative(sourceRoot, driverRoot),
    ".pr1858-driver",
    "Driver must use the declared isolated checkout.",
  );
  const driver = driverReceipt();
  const proof = sourceProof("before-overlay");
  writeJson("source-before.json", proof);
  assert.deepEqual(proof.mismatches, [], "Source must be exact before any fixture overlay.");
  assert(reportPath, "RUNNER_TEMP is required for the live JSON report.");
  assert(!existsSync(reportPath), "Refuse to reuse an earlier live report.");
  assert.deepEqual(walkFiles(liveOutput), [], "Live evidence directory must start empty.");
  mkdirSync(liveOutput, { recursive: true });
  mkdirSync(path.dirname(reportPath), { recursive: true });

  const original = readFileSync(path.join(sourceRoot, fixtureRelative), "utf8");
  assert.equal(
    gitBlob(Buffer.from(original)),
    target.canonicalFixtureBlob,
    "Canonical fixture must match its explicit source pin.",
  );
  const append = readFileSync(path.join(directory, "append-fixture.tsx"), "utf8");
  const config = readFileSync(
    path.join(directory, "vitest.pr1858-retry-evidence.config.ts"),
    "utf8",
  );
  assert(original.endsWith("});\n"), "Expected canonical outer describe terminator.");
  assert(!original.includes('describe("PR1858 review evidence"'), "Fixture already has evidence.");
  assert(
    !existsSync(path.join(sourceRoot, overlayRelative)),
    "Refuse to replace an existing file.",
  );
  assert(
    !existsSync(path.join(sourceRoot, configRelative)),
    "Refuse to replace an existing config.",
  );
  const observed = original.slice(0, -4) + append + "});\n";
  assert.equal(
    observed.slice(0, original.length - 4) + observed.slice(original.length - 4 + append.length),
    original,
    "Removing only the appended nested suite must recover every canonical byte.",
  );
  writeFileSync(path.join(sourceRoot, overlayRelative), observed, { flag: "wx" });
  writeFileSync(path.join(sourceRoot, configRelative), config, { flag: "wx" });
  writeFileSync(path.join(output, "canonical-fixture.tsx"), original);
  writeFileSync(path.join(output, "observed-fixture.tsx"), observed);
  writeFileSync(path.join(output, "append-fixture.tsx"), append);
  writeFileSync(path.join(output, "vitest.config.ts"), config);
  const manifest = {
    schemaVersion: 1,
    preparedAt: new Date().toISOString(),
    source: target.source,
    tree: target.tree,
    side: target.id,
    expectedSelected: target.expectedSelected,
    expectedPhases: target.phases,
    viewport: { width: 960, height: 1100 },
    liveOutput,
    liveReportPath: reportPath,
    originalFixture: fileReceipt(sourceRoot, fixtureRelative),
    overlay: fileReceipt(sourceRoot, overlayRelative),
    config: fileReceipt(sourceRoot, configRelative),
    driver,
    interpretation:
      "Before is current main without the feature. After is the reviewed repair. This pair demonstrates component behavior, not a causal control for every repaired backend defect.",
    backendBoundary:
      "Real production ChatView, CSS, router, menus and clicks; controlled native API acknowledgement and explicit projected server snapshot. No provider execution, checkpoint creation or native workspace restore is claimed.",
    fixtureTime:
      "Fixed fixture timestamps define settled turn durations. They do not measure test runtime or model latency.",
  };
  writeJson("provenance.json", manifest);
  assert(process.env.GITHUB_ENV, "GITHUB_ENV is required.");
  appendFileSync(
    process.env.GITHUB_ENV,
    [
      "VITE_PR1858_OUTPUT=" + liveOutput,
      "PR1858_REPORT=" + reportPath,
      "VITE_PR1858_SIDE=" + target.id,
      "VITE_PR1858_SOURCE=" + target.source,
      "",
    ].join("\n"),
  );
  console.log(JSON.stringify({ source: target.source, side: target.id, output, proof }));
}

function verify() {
  const errors = [];
  let manifest = null;
  let proof = null;
  let exits = null;
  let report = null;
  let selected = [];
  let observations = [];
  let focusTraces = [];
  const snapshots = [];
  const attempt = (fn) => {
    try {
      return fn();
    } catch (error) {
      errors.push(String(error));
      return null;
    }
  };

  // A failed or timed-out subprocess may leave a report/log writer alive.
  // Snapshot once outside those writers' paths, then parse and hash only the
  // retained copies. PNG/video live paths stay under the Vite workspace.
  attempt(() => {
    assert(target && reportPath);
    for (const relative of walkFiles(liveOutput)) {
      const allowed =
        relative === "vitest.log" ||
        relative === "exits.json" ||
        target.phases.some((name) => relative === name + ".png") ||
        /^video\/[^/]+\.webm$/.test(relative);
      assert(allowed, "Unexpected live evidence file: " + relative);
      const cap = relative.endsWith(".webm") ? 128 * 1024 * 1024 : 16 * 1024 * 1024;
      snapshots.push(snapshotFile(path.join(liveOutput, relative), relative, cap));
    }
  });
  attempt(() => {
    assert(reportPath);
    snapshots.push(snapshotFile(reportPath, "vitest.json", 16 * 1024 * 1024));
  });
  for (const snapshot of snapshots) {
    if (snapshot.possibleTail)
      errors.push("Incomplete or changing live evidence: " + snapshot.path);
  }
  writeJson("snapshot-captures.json", snapshots);
  attempt(() => {
    manifest = JSON.parse(readFileSync(path.join(output, "provenance.json"), "utf8"));
    assert(target && manifest.source === target.source && manifest.tree === target.tree);
    assert.deepEqual(driverReceipt(), manifest.driver, "Driver changed during the run.");
    assert.equal(
      fileReceipt(sourceRoot, fixtureRelative).gitBlob,
      manifest.originalFixture.gitBlob,
    );
    assert.deepEqual(fileReceipt(sourceRoot, overlayRelative), manifest.overlay);
    assert.deepEqual(fileReceipt(sourceRoot, configRelative), manifest.config);
    // Remove only byte-verified files created by prepare; no canonical source is edited.
    unlinkSync(path.join(sourceRoot, overlayRelative));
    unlinkSync(path.join(sourceRoot, configRelative));
  });
  attempt(() => {
    proof = sourceProof("after-browser-and-overlay-removal");
    writeJson("source-after.json", proof);
    assert.deepEqual(proof.mismatches, [], "Source must remain exact after the browser.");
  });
  attempt(() => {
    exits = JSON.parse(readFileSync(path.join(output, "exits.json"), "utf8"));
    assert(Number.isInteger(exits.vitest) && Number.isInteger(exits.tee));
    if (exits.vitest !== 0) errors.push("Actual Vitest exit was " + exits.vitest);
    if (exits.tee !== 0) errors.push("Actual tee exit was " + exits.tee);
  });
  attempt(() => {
    report = JSON.parse(readFileSync(path.join(output, "vitest.json"), "utf8"));
    selected = report.testResults
      .flatMap((file) => file.assertionResults)
      .filter((test) => selectedPattern.test(test.fullName));
    assert.equal(selected.length, target.expectedSelected, "Exact selected assertion count.");
    assert.equal(
      selected.filter((test) => test.fullName === captureName).length,
      1,
      "Exactly one actual evidence case.",
    );
    assert(
      selected.every((test) => test.status === "passed"),
      "Every selected case must pass.",
    );
    assert.equal(report.numFailedTests, 0);
    assert.equal(report.numPassedTests, target.expectedSelected);
    assert.equal(report.success, true);
  });
  attempt(() => {
    const log = readFileSync(path.join(output, "vitest.log"), "utf8").replace(
      /\u001b\[[0-9;]*m/g,
      "",
    );
    observations = log
      .split("\n")
      .filter((line) => line.includes("PR1858_OBSERVATION "))
      .map((line) => JSON.parse(line.slice(line.indexOf("PR1858_OBSERVATION ") + 19)));
    assert.deepEqual(
      observations.map((observation) => observation.phase),
      target.phases,
      "Each required screenshot phase must have one observation in order.",
    );
    for (const observation of observations) {
      assert.equal(observation.side, target.id);
      assert.equal(observation.source, target.source);
      assert.deepEqual(observation.viewport, { width: 960, height: 1100 });
    }
    if (target.id === "before") {
      assert(observations.every((observation) => observation.retryButton === null));
    } else {
      assert.equal(observations[1].retryButton?.disabled, false);
      assert.match(observations[2].menuText, /Medium \(current\)/);
      assert.match(observations[3].dialogText, /pre-retry snapshot/);
      assert.match(observations[4].pagerText, /2\s*\/\s*2/);
      assert.match(observations[5].pagerText, /1\s*\/\s*2/);
      assert.match(observations[6].pagerText, /2\s*\/\s*2/);
    }
  });
  attempt(() => {
    const log = readFileSync(path.join(output, "vitest.log"), "utf8").replace(
      /\u001b\[[0-9;]*m/g,
      "",
    );
    const prefix = "PR1858_FOCUS_TRACE ";
    focusTraces = log
      .split("\n")
      .filter((line) => line.includes(prefix))
      .map((line) => JSON.parse(line.slice(line.indexOf(prefix) + prefix.length)));
    writeJson("focus-traces.json", focusTraces);
    assert.equal(focusTraces.length, target.expectedSelected, "Every selected case has one trace.");
    assert.equal(new Set(focusTraces.map((trace) => trace.testName)).size, focusTraces.length);
    for (const trace of focusTraces) {
      assert.equal(trace.schemaVersion, 1);
      assert.equal(trace.side, target.id);
      assert.equal(trace.source, target.source);
      assert(
        selected.some((test) => test.fullName.endsWith(" " + trace.testName)),
        "A focus trace must belong to an actual selected canonical or capture case.",
      );
      assert.equal(trace.cap, 512);
      assert.equal(trace.droppedEvents, 0, "A truncated observer trace is incomplete evidence.");
      assert.equal(trace.observerErrors, 0);
      assert.equal(trace.owned, true, "Observer ownership changed before restoration.");
      assert.equal(trace.restored, true, "All native method identities must be restored.");
      assert(trace.events.length >= 2 && trace.events.length <= trace.cap);
      assert.equal(trace.events[0].kind, "observer-installed");
      assert.equal(trace.events.at(-1).kind, "observer-finishing");
      for (const [index, event] of trace.events.entries()) {
        assert.equal(event.sequence, index);
        assert(Number.isFinite(event.elapsedMs));
        if (index) assert(event.elapsedMs >= trace.events[index - 1].elapsedMs);
        assert(Number.isInteger(event.menuCount) && event.menuCount >= 0);
        assert.equal(typeof event.hasDocumentFocus, "boolean");
      }
      assert(Array.isArray(trace.pendingObservedRafs));
      assert(trace.pendingObservedRafs.every(Number.isInteger));
    }
  });
  attempt(() => {
    const files = walkFiles(output);
    const pngs = files.filter((relative) => relative.endsWith(".png"));
    assert.deepEqual(pngs.sort(), target.phases.map((name) => name + ".png").sort());
    for (const relative of pngs) {
      const bytes = readFileSync(path.join(output, relative));
      assert(
        bytes.length > 1024 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
      );
      assert.equal(bytes.readUInt32BE(16), 960);
      assert.equal(bytes.readUInt32BE(20), 1100);
    }
    const videos = files.filter(
      (relative) => relative.startsWith("video/") && relative.endsWith(".webm"),
    );
    assert.equal(videos.length, 1, "One actual browser-page recording is required.");
    const video = readFileSync(path.join(output, videos[0]));
    assert(video.length > 1024 && video.subarray(0, 4).equals(Buffer.from("1a45dfa3", "hex")));
    const probe = spawnSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,width,height,duration",
        "-of",
        "json",
        path.join(output, videos[0]),
      ],
      { encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
    );
    writeJson("video-probe.json", {
      file: videos[0],
      status: probe.status,
      signal: probe.signal,
      error: probe.error?.message ?? null,
      stdout: probe.stdout,
      stderr: probe.stderr,
    });
    assert.equal(probe.status, 0, "The actual recording must be readable by ffprobe.");
    assert.equal(probe.signal, null);
    assert.equal(probe.error, undefined);
    const metadata = JSON.parse(probe.stdout);
    const streams = metadata.streams.filter((stream) => stream.codec_type === "video");
    assert.equal(streams.length, 1);
    assert.equal(streams[0].width, 960);
    assert.equal(streams[0].height, 1100);
    assert(
      Number.isFinite(Number(metadata.format.duration)) && Number(metadata.format.duration) > 0,
    );
  });
  const files =
    attempt(() =>
      walkFiles(output)
        .filter((relative) => relative !== "verified.json")
        .map((relative) => fileReceipt(output, relative)),
    ) ?? [];
  const receipt = {
    schemaVersion: 1,
    verifiedAt: new Date().toISOString(),
    source: target?.source ?? null,
    tree: target?.tree ?? null,
    side: target?.id ?? null,
    driverHead: process.env.GITHUB_SHA ?? null,
    actualExits: exits,
    immutableSnapshotBoundary:
      "All subprocess-written outputs were copied once before parsing. No live path is uploaded.",
    snapshots,
    verificationErrors: errors,
    passed: exits?.vitest === 0 && exits?.tee === 0 && errors.length === 0,
    selectedTests: selected.map(({ fullName, status, failureMessages }) => ({
      fullName,
      status,
      failureMessages,
    })),
    unselectedTests: report?.numPendingTests ?? null,
    observations,
    focusTraces,
    sourceProof: proof,
    files,
  };
  writeJson("verified.json", receipt);
  console.log(
    JSON.stringify({
      source: receipt.source,
      side: receipt.side,
      actualExits: exits,
      verificationErrors: errors,
      selectedTests: receipt.selectedTests,
      fileCount: files.length,
      passed: receipt.passed,
    }),
  );
  if (!receipt.passed) process.exitCode = exits?.vitest || exits?.tee || 1;
}

try {
  if (phase === "matrix") {
    assert(process.env.GITHUB_OUTPUT, "GITHUB_OUTPUT is required.");
    driverReceipt();
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      "matrix=" + JSON.stringify({ include: targets }) + "\n",
    );
  } else {
    mkdirSync(output, { recursive: true });
    if (phase === "prepare") prepare();
    else if (phase === "verify") verify();
    else throw new Error("Use matrix, prepare or verify.");
  }
} catch (error) {
  mkdirSync(output, { recursive: true });
  writeJson("driver-failure-" + (phase ?? "unknown") + ".json", {
    failedAt: new Date().toISOString(),
    phase,
    source: target?.source ?? null,
    actualError: String(error),
  });
  console.error(error);
  process.exitCode = 1;
}

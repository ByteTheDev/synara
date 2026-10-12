import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = "b7fd69812cb169c60a5b9fac17b05b6ff81b5322";
const TREE = "6b5e0bc1756d8f0586aa67b9bf1c30ea266cd158";
const COMMAND = ["bunx", "turbo", "run", "test", "--filter=@synara/cli", "--", "--shard=3/3"];
const LOG_CAP_BYTES = 32 * 1024 * 1024;
const DEADLINE_MS = 30 * 60 * 1000;
const DRAIN_MS = 10 * 1000;
const digest = (data) => createHash("sha256").update(data).digest("hex");
const gitBlob = (data) =>
  createHash("sha1")
    .update("blob " + data.length + "\0")
    .update(data)
    .digest("hex");
const now = () => new Date().toISOString();
const errorRecord = (error) => ({
  name: error.name,
  code: error.code ?? null,
  message: error.message,
});

function sourceProof(root, stage) {
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
  const head = git("rev-parse", "HEAD").toString().trim();
  const tree = git("rev-parse", "HEAD^{tree}").toString().trim();
  assert.equal(head, SOURCE);
  assert.equal(tree, TREE);
  const listing = git("ls-tree", "-r", "-z", "HEAD");
  let count = 0;
  for (const row of listing.toString().split("\0").filter(Boolean)) {
    const match = /^(\d+) (blob) ([0-9a-f]{40})\t(.+)$/.exec(row);
    assert(match, "Unexpected tracked entry " + row.slice(0, 120));
    const [, mode, , sha, relative] = match;
    const file = path.join(root, relative);
    const st = lstatSync(file);
    assert(st.isFile(), "Tracked source must remain a regular file: " + relative);
    assert.equal((st.mode & 0o111) !== 0, mode === "100755", relative);
    assert.equal(gitBlob(readFileSync(file)), sha, relative);
    count++;
  }
  assert.equal(count, 9035);
  git("diff", "--exit-code", "HEAD", "--");
  return {
    stage,
    at: now(),
    head,
    tree,
    trackedFiles: count,
    rawBytesAndModesVerified: true,
    listingSha256: digest(listing),
    untrackedQualification:
      "Only tracked source identity is claimed; the separately pinned driver is an untracked sibling directory.",
  };
}

export async function observeCommand({
  command,
  cwd,
  logPath,
  deadlineMs = DEADLINE_MS,
  drainMs = DRAIN_MS,
  capBytes = LOG_CAP_BYTES,
  spawnChild = spawn,
}) {
  assert(!existsSync(logPath), "Refuse an existing live log");
  const fd = openSync(logPath, "wx");
  const startedAt = now();
  const started = performance.now();
  let child;
  let timer;
  let drainTimer;
  let settled = false;
  let sawExit = false;
  let sawClose = false;
  let rootExit = null;
  let rootSignal = null;
  let closeCode = null;
  let closeSignal = null;
  let deadline = false;
  let killAttempted = false;
  let killReturned = null;
  let forcedOutputCutoff = false;
  let observedBytes = 0;
  let retainedBytes = 0;
  const processErrors = [];
  const outputErrors = [];
  const write = (data) => {
    observedBytes += data.length;
    const amount = Math.min(data.length, Math.max(0, capBytes - retainedBytes));
    try {
      let offset = 0;
      while (offset < amount) offset += writeSync(fd, data, offset, amount - offset);
      retainedBytes += amount;
    } catch (error) {
      outputErrors.push(errorRecord(error));
    }
  };
  const result = await new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      child?.stdout?.off("data", write);
      child?.stderr?.off("data", write);
      if (!sawClose && child) {
        forcedOutputCutoff = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
      }
      closeSync(fd);
      const observerStatus = deadline
        ? 124
        : processErrors.length
          ? 127
          : outputErrors.length || observedBytes > capBytes
            ? 1
            : (rootExit ?? 1);
      resolve({
        command,
        cwd,
        startedAt,
        completedAt: now(),
        elapsedMs: performance.now() - started,
        deadlineMs,
        drainMs,
        deadline,
        killAttempted,
        killReturned,
        actualRootExitObserved: sawExit,
        actualRootExit: rootExit,
        actualRootSignal: rootSignal,
        closeObserved: sawClose,
        closeCode,
        closeSignal,
        processErrors,
        outputErrors,
        observedBytes,
        retainedBytes,
        capBytes,
        capped: observedBytes > capBytes,
        forcedOutputCutoff,
        observerStatus,
        descendantQualification:
          "Only the owned root handle is signalled. Root exit and pipe close are recorded separately; descendant exit is not inferred.",
      });
    };
    try {
      child = spawnChild(command[0], command.slice(1), {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      });
      child.stdout.on("data", write);
      child.stderr.on("data", write);
      child.on("exit", (code, signal) => {
        sawExit = true;
        rootExit = code;
        rootSignal = signal;
      });
      child.on("close", (code, signal) => {
        sawClose = true;
        closeCode = code;
        closeSignal = signal;
        finish();
      });
      child.on("error", (error) => {
        processErrors.push({ ...errorRecord(error), afterDeadline: deadline });
        if (!deadline) finish();
      });
      timer = setTimeout(() => {
        deadline = true;
        drainTimer = setTimeout(finish, drainMs);
        if (!sawExit && child.exitCode === null && child.signalCode === null) {
          killAttempted = true;
          try {
            killReturned = child.kill("SIGKILL");
          } catch (error) {
            processErrors.push({ ...errorRecord(error), afterDeadline: true });
          }
        }
      }, deadlineMs);
    } catch (error) {
      processErrors.push({ ...errorRecord(error), afterDeadline: false });
      finish();
    }
  });
  return result;
}

async function main() {
  assert(process.env.RUNNER_TEMP, "RUNNER_TEMP must locate the owned diagnostic directory");
  const sourceRoot = path.resolve(process.env.GITHUB_WORKSPACE);
  const root = path.join(process.env.RUNNER_TEMP, "pr1858-server3-observer");
  const live = path.join(root, "live");
  const frozen = path.join(root, "frozen");
  assert(!existsSync(root), "Refuse reused diagnostic output");
  mkdirSync(live, { recursive: true });
  mkdirSync(frozen);
  const json = (name, value) =>
    writeFileSync(path.join(frozen, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  const failures = [];
  let result = null;
  const driverPath = fileURLToPath(import.meta.url);
  json("provenance.json", {
    source: SOURCE,
    tree: TREE,
    driverHead: process.env.GITHUB_SHA,
    driverRunnerSha256: digest(readFileSync(driverPath)),
    command: COMMAND,
    originalFailedRun: 38187373364,
    originalFailedJob: 114612552287,
    originalLogAccess:
      "Purpose-built connector log reads returned Transport closed. This new diagnostic does not reclassify the original failed job.",
    environment: { platform: process.platform, architecture: process.arch, node: process.version },
    qualification:
      "Exact source and canonical server 3/3 argv, with a separate bounded root observer and retained raw output. No source/test assertion is modified and no timeout is reported as success.",
  });
  try {
    json("source-before.json", sourceProof(sourceRoot, "before"));
    result = await observeCommand({
      command: COMMAND,
      cwd: sourceRoot,
      logPath: path.join(live, "vitest.log"),
    });
    json("process.json", result);
    if (result.observerStatus !== 0)
      failures.push("Observed command status " + result.observerStatus);
    if (
      result.actualRootExit !== 0 ||
      !result.closeObserved ||
      result.deadline ||
      result.forcedOutputCutoff ||
      result.capped
    )
      failures.push(
        "Actual clean root completion and complete captured pipes were not established",
      );
  } catch (error) {
    failures.push(errorRecord(error));
  } finally {
    const log = path.join(live, "vitest.log");
    if (existsSync(log)) {
      const captureStartedAt = now();
      const before = statSync(log).size;
      assert(before <= LOG_CAP_BYTES);
      const bytes = readFileSync(log);
      const after = statSync(log).size;
      writeFileSync(path.join(frozen, "vitest.log"), bytes, { flag: "wx" });
      json("log-snapshot.json", {
        captureStartedAt,
        captureCompletedAt: now(),
        observedInitialBytes: before,
        observedEndBytes: after,
        capturedBytes: bytes.length,
        capBytes: LOG_CAP_BYTES,
        sha256: digest(bytes),
        possibleTail: result?.forcedOutputCutoff ?? true,
        qualification:
          "One immutable retained byte prefix after the observer detached its readers; live files are never uploaded.",
      });
    }
    try {
      json("source-after.json", sourceProof(sourceRoot, "after"));
    } catch (error) {
      failures.push(errorRecord(error));
    }
    json("result.json", {
      passed: failures.length === 0,
      failures,
      actualCommand: result,
      originalFailedJobRemainsHistoricalFailure: true,
    });
    const files = readdirSync(frozen)
      .sort()
      .map((name) => {
        const bytes = readFileSync(path.join(frozen, name));
        return { path: name, bytes: bytes.length, sha256: digest(bytes), gitBlob: gitBlob(bytes) };
      });
    json("manifest.json", { source: SOURCE, tree: TREE, files });
  }
  console.log(
    JSON.stringify({
      source: SOURCE,
      passed: failures.length === 0,
      observedStatus: result?.observerStatus,
      actualRootExit: result?.actualRootExit,
      failures,
    }),
  );
  process.exitCode = failures.length === 0 ? 0 : result?.observerStatus || 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();

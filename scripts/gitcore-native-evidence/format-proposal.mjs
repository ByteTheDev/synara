import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, writeFileSync } from "node:fs";
import path from "node:path";

const SOURCE = "c2ad55894c40d46f6685d332cc87cb6365c6d0a4";
const TREE = "94a54e15174d904613abeae2380c04c30b00d448";
const FILES = new Map([
  ["apps/server/src/git/Layers/GitCore.ts", "0edcd0aa35825d1bd171b0ddb8d18dcf40553f59"],
  ["apps/server/src/git/Layers/GitCore.test.ts", "e8c01bc51583886e4eb46998992bd86fa9593398"],
]);
const root = process.cwd();
const driver = path.join(root, ".pr-driver");
const hash = (bytes, algorithm = "sha256") => createHash(algorithm).update(bytes).digest("hex");
const blob = (bytes) => hash(Buffer.concat([Buffer.from("blob " + bytes.length + "\0"), bytes]), "sha1");
const commands = [];
const MAX_BYTES = 512 * 1024;

function stableRead(file) {
  const initialPath = lstatSync(file);
  if (!initialPath.isFile() || initialPath.isSymbolicLink() || initialPath.size > MAX_BYTES) {
    throw new Error("Invalid or oversized formatter input/output: " + file);
  }
  const fd = openSync(file, "r");
  try {
    const initial = fstatSync(fd);
    const same = (a, b) => a.dev === b.dev && a.ino === b.ino &&
      a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
    if (!initial.isFile() || !same(initialPath, initial) || initial.size > MAX_BYTES) {
      throw new Error("Formatter file identity changed before allocation");
    }
    const bytes = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error("Formatter file ended during snapshot");
      offset += count;
    }
    const tail = Buffer.alloc(1);
    if (readSync(fd, tail, 0, 1, initial.size) !== 0 ||
        !same(initial, fstatSync(fd)) || !same(initial, lstatSync(file))) {
      throw new Error("Formatter file changed during snapshot");
    }
    return { bytes, capturedAt: new Date().toISOString(), sha256: hash(bytes), gitBlob: blob(bytes) };
  } finally {
    closeSync(fd);
  }
}

async function observe(executable, args, cwd = root, timeoutMs = 30_000) {
  const result = await new Promise((resolve) => {
    let finished = false;
    let deadlineTimer;
    let drainTimer;
    let drainDue = Infinity;
    const chunks = { stdout: [], stderr: [] };
    let capturedBytes = 0;
    const observed = {
      executable, args, cwd, timeoutMs, rootExit: null, close: null,
      processErrors: [], deadlineReachedAt: null, outputCutoff: null, signalAttempts: [],
    };
    const child = spawn(executable, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const signalOwned = (signal) => {
      if (observed.rootExit !== null) return;
      try { observed.signalAttempts.push({ signal, sent: child.kill(signal) }); }
      catch (error) { observed.signalAttempts.push({ signal, sent: false, error: String(error) }); }
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(deadlineTimer);
      clearTimeout(drainTimer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      if (observed.close === null) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      resolve({ ...observed, stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8") });
    };
    const boundDrain = (reason, durationMs) => {
      const due = performance.now() + durationMs;
      if (due >= drainDue) return;
      drainDue = due;
      clearTimeout(drainTimer);
      drainTimer = setTimeout(() => {
        if (finished) return;
        observed.outputCutoff = { reason, at: new Date().toISOString() };
        signalOwned("SIGKILL");
        finish();
      }, durationMs);
    };
    const record = (data, stream) => {
      if (finished) return;
      capturedBytes += data.length;
      if (capturedBytes > MAX_BYTES) {
        observed.outputCutoff = { reason: "command output exceeds bound", at: new Date().toISOString() };
        signalOwned("SIGKILL");
        finish();
        return;
      }
      chunks[stream].push(Buffer.from(data));
    };
    const onStdout = (data) => record(data, "stdout");
    const onStderr = (data) => record(data, "stderr");
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", (code, signal) => {
      if (finished) return;
      observed.rootExit = { code, signal, at: new Date().toISOString() };
      boundDrain("root exit without completed pipe drain", 5_000);
    });
    child.on("error", (error) => {
      if (finished) return;
      observed.processErrors.push(String(error));
      boundDrain("process error without completed pipe drain", 5_000);
    });
    child.on("close", (code, signal) => {
      if (finished) return;
      observed.close = { code, signal, at: new Date().toISOString() };
      finish();
    });
    deadlineTimer = setTimeout(() => {
      if (finished) return;
      observed.deadlineReachedAt = new Date().toISOString();
      signalOwned("SIGTERM");
      boundDrain("command deadline without completed pipe drain", 5_000);
    }, timeoutMs);
  });
  commands.push(result);
  return result;
}

async function run(executable, args, cwd = root, allowed = [0], timeoutMs = 30_000) {
  const result = await observe(executable, args, cwd, timeoutMs);
  if (!allowed.includes(result.rootExit?.code) || result.rootExit?.signal ||
      !result.close || result.close.code !== result.rootExit.code || result.close.signal ||
      result.processErrors.length || result.deadlineReachedAt || result.outputCutoff) {
    throw new Error("Actual formatter proposal command failed: " + executable);
  }
  return result;
}

async function guard() {
  if ((await run("git", ["rev-parse", "HEAD"])).stdout.trim() !== SOURCE ||
      (await run("git", ["rev-parse", "HEAD^{tree}"])).stdout.trim() !== TREE) {
    throw new Error("Wrong formatter source");
  }
  await run("git", ["diff", "--exit-code", "HEAD", "--"]);
  for (const [relative, expected] of FILES) {
    if (stableRead(path.join(root, relative)).gitBlob !== expected) throw new Error("Source blob changed");
  }
  const expectedDriver = process.env.DRIVER_SHA;
  if (!/^[a-f0-9]{40}$/u.test(expectedDriver ?? "") ||
      (await run("git", ["rev-parse", "HEAD"], driver)).stdout.trim() !== expectedDriver) {
    throw new Error("Wrong formatter driver");
  }
  await run("git", ["diff", "--exit-code", "HEAD", "--"], driver);
}

const receipt = {
  source: SOURCE, tree: TREE, driver: process.env.DRIVER_SHA ?? null,
  startedAt: new Date().toISOString(), complete: false, files: [],
  qualification: "Canonical Oxfmt runs only on owned copies beneath the source configuration. The original format-check outcome remains unchanged. Retained proposals are bounded stable byte snapshots; no descendant cleanup is inferred.",
};
try {
  await guard();
  const owned = mkdtempSync(path.join(root, "gitcore-format-proposal-"));
  const prepared = [];
  for (const [relative] of FILES) {
    const source = stableRead(path.join(root, relative));
    const copy = path.join(owned, relative);
    mkdirSync(path.dirname(copy), { recursive: true });
    writeFileSync(copy, source.bytes, { flag: "wx" });
    prepared.push({ relative, copy, source });
  }
  receipt.configuration = stableRead(path.join(root, ".oxfmtrc.json")).sha256;
  receipt.formatter = await run("bun", ["run", "fmt", ...prepared.map((file) => file.copy)], root, [0], 120_000);
  for (const file of prepared) {
    const formatted = stableRead(file.copy);
    // Diff two immutable snapshots, never a still-owned formatter output.
    const snapshotBefore = path.join(owned, "frozen-before", file.relative);
    const snapshotAfter = path.join(owned, "frozen-after", file.relative);
    for (const [target, bytes] of [[snapshotBefore, file.source.bytes], [snapshotAfter, formatted.bytes]]) {
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: "wx" });
    }
    const difference = await run("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv",
      "--no-color", "--unified=3", "--", snapshotBefore, snapshotAfter], root, [0, 1]);
    receipt.files.push({
      path: file.relative, before: { bytes: file.source.bytes.length, sha256: file.source.sha256, gitBlob: file.source.gitBlob },
      after: { bytes: formatted.bytes.length, sha256: formatted.sha256, gitBlob: formatted.gitBlob,
        capturedAt: formatted.capturedAt },
      diffExit: difference.rootExit.code, patch: difference.stdout,
    });
  }
  await guard();
  receipt.complete = true;
} catch (error) {
  receipt.error = String(error);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  receipt.commands = commands;
  const output = path.join(root, "gitcore-format-evidence");
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "proposal.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log("GITCORE_FORMAT_PROPOSAL " + JSON.stringify(receipt));
}

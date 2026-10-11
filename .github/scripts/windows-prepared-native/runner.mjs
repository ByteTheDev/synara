import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Use an isolated hosted runner");
assert.ok(process.env.GITHUB_WORKSPACE && process.env.RUNNER_TEMP);
const root = resolve(process.env.GITHUB_WORKSPACE, "source");
const driver = resolve(process.env.GITHUB_WORKSPACE, "driver");
const scripts = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(scripts, "pins.json"), "utf8"));
const label = process.env.PREPARED_NATIVE_LABEL;
assert.ok(label === "before" || label === "after");
const source = pins.sources[label];
const output = join(resolve(process.env.RUNNER_TEMP), "runtime-prepared-native-evidence");
const privateDirectory = join(resolve(process.env.RUNNER_TEMP), "runtime-prepared-native-private");
const live = join(privateDirectory, "live");
mkdirSync(output, { recursive: true });
mkdirSync(privateDirectory);
mkdirSync(live);
const platform = process.platform === "win32" ? "windows-x64" : "linux-x64";
const pin = pins.platforms[platform];
assert.equal(process.platform, pin.os);
assert.equal(process.arch, "x64");
const save = (name, value) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) =>
  createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
const snapshots = new Map();
const driverPaths = [
  ".github/workflows/windows-prepared-native.yml",
  ".github/scripts/windows-prepared-native/runner.mjs",
  ".github/scripts/windows-prepared-native/extract.py",
  ".github/scripts/windows-prepared-native/pins.json",
  ".github/scripts/windows-prepared-native/PreparedRuntime.native.test.ts",
];

// Workers that outlive an observer deadline may still append to the private
// live directory. Artifacts contain only immutable bounded byte-prefix copies.
function freeze(name) {
  if (snapshots.has(name)) return snapshots.get(name);
  assert.match(name, /^[a-zA-Z0-9_.-]+$/u);
  const file = join(live, name);
  if (!existsSync(file)) return undefined;
  const startedAt = new Date().toISOString();
  const before = statSync(file);
  assert.equal(before.isFile(), true);
  const cap = 10 * 1024 * 1024;
  const prefix = Buffer.alloc(Math.min(before.size, cap));
  const fd = openSync(file, "r");
  let offset = 0;
  try {
    while (offset < prefix.length) {
      const count = readSync(fd, prefix, offset, prefix.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
  } finally {
    closeSync(fd);
  }
  const after = statSync(file);
  const bytes = prefix.subarray(0, offset);
  writeFileSync(join(output, name), bytes, { flag: "wx" });
  const result = {
    name,
    startedAt,
    completedAt: new Date().toISOString(),
    observedBytesBefore: before.size,
    observedBytesAfter: after.size,
    bytes: bytes.length,
    sha256: hash(bytes),
    cap,
    truncated: bytes.length < before.size,
    changedWhileReading: before.size !== after.size || before.mtimeMs !== after.mtimeMs,
    boundary: "Immutable observed prefix; later private writer output is not claimed as captured",
  };
  snapshots.set(name, result);
  return result;
}

function sourceGuard(phase) {
  const checks = [
    { cwd: root, args: ["rev-parse", "HEAD"], expected: source.head },
    { cwd: root, args: ["rev-parse", "HEAD^{tree}"], expected: source.tree },
    { cwd: root, args: ["status", "--porcelain=v1", "--untracked-files=all"], expected: "" },
    { cwd: root, args: ["diff", "--exit-code", "HEAD", "--"], expected: "" },
    { cwd: driver, args: ["rev-parse", "HEAD"], expected: process.env.GITHUB_SHA },
    { cwd: driver, args: ["status", "--porcelain=v1", "--untracked-files=all"], expected: "" },
    { cwd: driver, args: ["diff", "--exit-code", "HEAD", "--"], expected: "" },
  ];
  const results = checks.map((check) => {
    const result = spawnSync("git", check.args, {
      cwd: check.cwd,
      shell: false,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      ...check,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  });
  save("source-" + phase + ".json", { label, source, results });
  for (const result of results) {
    assert.equal(result.error, null);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), result.expected);
  }
  assert.equal(existsSync(join(root, pins.testPath)), false);
  assert.equal(
    JSON.parse(readFileSync(join(root, "apps/server/package.json"), "utf8")).dependencies[
      "@opencode/client"
    ],
    pins.version,
  );
}

// File descriptors avoid a descendant-held pipe hiding the root exit. A deadline
// signals only the still-live ChildProcess handle; it does not prove descendant cleanup.
async function observe(name, command, args, { cwd = root, env, timeoutMs }) {
  const log = join(live, name + ".log");
  const fd = openSync(log, "wx");
  const result = {
    command,
    args,
    cwd,
    startedAt: new Date().toISOString(),
    elapsedMs: null,
    actualExitCode: null,
    actualSignal: null,
    closeObserved: false,
    deadline: false,
    handleKillAttempted: false,
    handleKillReturned: null,
    processErrors: [],
    logSnapshotError: null,
    descendantCleanup: "Not inferred from root process exit",
  };
  const started = performance.now();
  let child;
  let deadline;
  let grace;
  try {
    await new Promise((resolvePromise) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        clearTimeout(grace);
        resolvePromise();
      };
      try {
        child = spawn(command, args, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", fd, fd],
        });
      } catch (error) {
        result.processErrors.push(String(error));
        finish();
        return;
      }
      child.on("exit", (code, signal) => {
        result.actualExitCode = code;
        result.actualSignal = signal;
      });
      child.on("close", () => {
        result.closeObserved = true;
        finish();
      });
      child.on("error", (error) => {
        result.processErrors.push(error.message);
        if (child.pid === undefined && !result.deadline) finish();
      });
      deadline = setTimeout(() => {
        result.deadline = true;
        if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
          result.handleKillAttempted = true;
          try {
            result.handleKillReturned = child.kill("SIGKILL");
          } catch (error) {
            result.processErrors.push(String(error));
          }
        }
        grace = setTimeout(finish, 10_000);
      }, timeoutMs);
    });
  } finally {
    closeSync(fd);
    result.elapsedMs = performance.now() - started;
    try {
      const snapshot = freeze(name + ".log");
      result.logBytes = snapshot.bytes;
      result.logSha256 = snapshot.sha256;
      result.logSnapshot = snapshot;
    } catch (error) {
      result.logSnapshotError = String(error);
    }
    save(name + "-process.json", result);
  }
  assert.equal(result.deadline, false, name + " exceeded its observation deadline");
  assert.equal(result.closeObserved, true, name + " did not close");
  assert.deepEqual(result.processErrors, []);
  assert.equal(result.logSnapshotError, null);
  assert.equal(result.actualSignal, null);
  assert.equal(
    result.actualExitCode,
    0,
    name + " failed; preserve its original log and process result",
  );
  return result;
}

async function download() {
  const archive = join(privateDirectory, "opencode.tgz");
  const fd = openSync(archive, "wx");
  const hashes = Object.fromEntries(
    ["sha1", "sha256", "sha512"].map((name) => [name, createHash(name)]),
  );
  const result = { url: pin.url, status: null, bytes: 0, contentLength: null, error: null };
  let response;
  try {
    response = await fetch(pin.url, { redirect: "error", signal: AbortSignal.timeout(300_000) });
    result.status = response.status;
    result.contentLength = response.headers.get("content-length");
    assert.equal(response.status, 200);
    assert.equal(Number(result.contentLength), pin.archiveBytes);
    assert.ok(response.body);
    for await (const chunk of response.body) {
      result.bytes += chunk.length;
      assert.ok(result.bytes <= pin.archiveBytes, "Archive exceeds its exact published byte count");
      for (const digest of Object.values(hashes)) digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(fd, chunk, offset);
    }
    assert.equal(result.bytes, pin.archiveBytes);
    result.sha1 = hashes.sha1.digest("hex");
    result.sha256 = hashes.sha256.digest("hex");
    result.sha512Base64 = hashes.sha512.digest("base64");
    assert.equal(result.sha1, pin.sha1);
    assert.equal(result.sha256, pin.sha256);
    assert.equal(result.sha512Base64, pin.sha512Base64);
    return archive;
  } catch (error) {
    result.error = String(error);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    throw error;
  } finally {
    closeSync(fd);
    save("archive-integrity.json", result);
  }
}

let fixtureInstalled = false;
function assertFixture() {
  const bytes = readFileSync(join(root, pins.testPath));
  assert.equal(blob(bytes), pins.fixtureBlob);
  assert.equal(hash(bytes), pins.fixtureSha256);
}
function installFixture() {
  assert.equal(existsSync(join(root, pins.testPath)), false);
  const bytes = readFileSync(join(scripts, "PreparedRuntime.native.test.ts"));
  assert.equal(blob(bytes), pins.fixtureBlob);
  assert.equal(hash(bytes), pins.fixtureSha256);
  writeFileSync(join(root, pins.testPath), bytes, { flag: "wx" });
  fixtureInstalled = true;
  writeFileSync(join(output, "PreparedRuntime.native.test.ts"), bytes);
  assertFixture();
}
function restoreFixture() {
  if (!fixtureInstalled) return;
  assertFixture();
  unlinkSync(join(root, pins.testPath));
  fixtureInstalled = false;
}

function accounting() {
  const path = join(output, "native.json");
  if (!existsSync(path)) return undefined;
  const report = JSON.parse(readFileSync(path, "utf8"));
  const tests = report.testResults.flatMap((suite) => suite.assertionResults);
  save("native-test-accounting.json", {
    label,
    source,
    success: report.success,
    total: report.numTotalTests,
    passed: report.numPassedTests,
    failed: report.numFailedTests,
    pending: report.numPendingTests,
    tests: tests.map(({ fullName, status, duration, failureMessages }) => ({
      fullName,
      status,
      duration,
      failureMessages,
    })),
  });
  return { report, tests };
}

const failures = [];
let executedBinary;
let executedBinarySha256;
try {
  sourceGuard("before");
  save("provenance.json", {
    label,
    source,
    platform,
    driver: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    pins,
    sourceLockSha256: hash(readFileSync(join(root, "bun.lock"))),
    sourceSetupActionSha256: hash(
      readFileSync(join(root, ".github/actions/setup-workspace/action.yml")),
    ),
    driverFiles: driverPaths.map((path) => ({
      path,
      gitBlob: blob(readFileSync(join(driver, path))),
      sha256: hash(readFileSync(join(driver, path))),
    })),
    qualification:
      "Identical added fixture over exact Before/After production source. Real managed native CLI, production adapter/runtime and process-tree cleanup. The signal observation delegates original commands unchanged; no teardown or snapshot factory is substituted. No model inference, GUI, full application quit, five-minute expiry or universal performance claim. Independent hosted runners may both pass ordinary native behavior; prior failures remain separate.",
  });
  const archive = await download();
  await observe(
    "extract",
    "python",
    [
      join(scripts, "extract.py"),
      archive,
      join(privateDirectory, "extracted"),
      join(scripts, "pins.json"),
      platform,
    ],
    { env: process.env, timeoutMs: 60_000 },
  );
  const extraction = JSON.parse(readFileSync(join(output, "extract.log"), "utf8"));
  save("extraction.json", extraction);
  const binary = extraction.executable;
  assert.equal(
    resolve(binary),
    join(privateDirectory, "extracted", platform === "windows-x64" ? "opencode.exe" : "opencode"),
  );
  executedBinarySha256 = hash(readFileSync(binary));
  assert.equal(
    executedBinarySha256,
    extraction.members.find((entry) => entry.path.includes("/bin/")).sha256,
  );
  executedBinary = binary;
  save("binary-before.json", { path: binary, sha256: executedBinarySha256, version: pins.version });
  const permitted = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "TERM",
    "CI",
  ]);
  const nativeEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => permitted.has(name.toUpperCase())),
  );
  const home = join(privateDirectory, "home");
  const temp = join(privateDirectory, "temp");
  mkdirSync(home);
  mkdirSync(temp);
  Object.assign(nativeEnvironment, {
    HOME: home,
    USERPROFILE: home,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
  });
  for (const [name, directory] of Object.entries({
    XDG_CONFIG_HOME: "config",
    XDG_DATA_HOME: "data",
    XDG_CACHE_HOME: "cache",
    XDG_STATE_HOME: "state",
    APPDATA: "appdata",
    LOCALAPPDATA: "localappdata",
  })) {
    nativeEnvironment[name] = join(home, directory);
    mkdirSync(nativeEnvironment[name]);
  }
  await observe("version", binary, ["--version"], { env: nativeEnvironment, timeoutMs: 30_000 });
  assert.equal(
    readFileSync(join(output, "version.log"), "utf8").trim(),
    "opencode v" + pins.version,
  );
  sourceGuard("before-fixture");
  installFixture();
  try {
    await observe(
      "native",
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "src/provider/Layers/PreparedRuntime.native.test.ts",
        "--reporter=verbose",
        "--reporter=json",
        "--outputFile=" + join(live, "native.json"),
      ],
      {
        cwd: join(root, "apps/server"),
        timeoutMs: 360_000,
        env: {
          ...nativeEnvironment,
          SYNARA_PREPARED_NATIVE: "1",
          OPENCODE_LIVE_BINARY: binary,
          PREPARED_NATIVE_EVIDENCE: live,
          PREPARED_NATIVE_PRIVATE: privateDirectory,
          PREPARED_NATIVE_SOURCE: source.head,
        },
      },
    );
  } finally {
    for (const name of [
      "native.json",
      "cold-ready.ndjson",
      "session-warm-reuse.ndjson",
      "startup-cancellation.ndjson",
    ])
      freeze(name);
    accounting();
  }
  assertFixture();
  const { report, tests } = accounting();
  assert.equal(report.success, true);
  assert.equal(report.numTotalTests, pins.nativeTests);
  assert.equal(report.numPassedTests, pins.nativeTests);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(tests.length, pins.nativeTests);
  assert.ok(tests.every((test) => test.status === "passed"));
  const cases = ["cold-ready", "session-warm-reuse", "startup-cancellation"].map((name) => {
    const bytes = readFileSync(join(output, name + ".ndjson"));
    const records = bytes
      .toString("utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const summaries = records.filter((record) => record.kind === "owned-exit-summary");
    const exits = records.filter((record) => record.kind === "production-scope-exit");
    assert.equal(summaries.length, 1);
    assert.equal(exits.length, 1);
    assert.equal(summaries[0].passed, true);
    assert.equal(exits[0].exit, "Success");
    assert.equal(summaries[0].children.length, 1);
    assert.ok(
      summaries[0].children.every(
        (child) => child.rawExit === "success" && Number.isInteger(child.actualCode),
      ),
    );
    assert.ok(summaries[0].signals.length > 0);
    assert.equal(summaries[0].signals[0].captureComplete, true);
    assert.equal(summaries[0].signals[0].includeRootTree, true);
    return { name, sha256: hash(bytes), recordCount: records.length };
  });
  for (const snapshot of snapshots.values()) {
    assert.equal(snapshot.truncated, false, snapshot.name + " exceeded its capture bound");
    assert.equal(snapshot.changedWhileReading, false, snapshot.name + " changed during capture");
  }
  save("native-qualification.json", {
    label,
    source,
    fixtureBlob: pins.fixtureBlob,
    binarySha256: executedBinarySha256,
    passed: pins.nativeTests,
    skipped: 0,
    cases,
  });
} catch (error) {
  failures.push(String(error));
  console.error(String(error));
} finally {
  if (executedBinary) {
    try {
      const sha256 = hash(readFileSync(executedBinary));
      save("binary-after.json", { path: executedBinary, sha256 });
      assert.equal(sha256, executedBinarySha256);
    } catch (error) {
      failures.push(String(error));
    }
  }
  try {
    restoreFixture();
  } catch (error) {
    failures.push(String(error));
  }
  try {
    sourceGuard("after");
  } catch (error) {
    failures.push(String(error));
  }
  try {
    const files = readdirSync(live);
    assert.ok(files.length <= 32);
    for (const name of files) freeze(name);
  } catch (error) {
    failures.push(String(error));
  }
  save("snapshots.json", [...snapshots.values()]);
  save("result.json", { passed: failures.length === 0, failures });
  save(
    "evidence-manifest.json",
    readdirSync(output)
      .filter((name) => name !== "evidence-manifest.json")
      .map((name) => {
        const bytes = readFileSync(join(output, name));
        return { name, bytes: bytes.length, sha256: hash(bytes) };
      }),
  );
  if (failures.length) process.exitCode = 1;
}

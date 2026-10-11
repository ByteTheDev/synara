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
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Use an isolated hosted runner");
assert.equal(process.platform, "win32");
assert.ok(process.env.GITHUB_WORKSPACE && process.env.RUNNER_TEMP);
const root = resolve(process.env.GITHUB_WORKSPACE, "source");
const driver = resolve(process.env.GITHUB_WORKSPACE, "driver");
const scripts = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(scripts, "pins.json"), "utf8"));
const label = process.env.WORKER_ENV_MODE;
assert.ok(label === "minimal" || label === "platform");
const source = pins.source;
const output = join(resolve(process.env.RUNNER_TEMP), "windows-worker-env-evidence");
const privateDirectory = join(resolve(process.env.RUNNER_TEMP), "windows-worker-env-private");
const live = join(privateDirectory, "live");
mkdirSync(output, { recursive: true });
mkdirSync(privateDirectory);
mkdirSync(live);
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
  ".github/workflows/windows-worker-env.yml",
  ".github/scripts/windows-worker-env/runner.mjs",
  ".github/scripts/windows-worker-env/pins.json",
  ".github/scripts/windows-worker-env/WorkerEnvironment.native.test.ts",
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
  for (const [path, expected] of Object.entries(pins.productionBlobs)) {
    assert.equal(blob(readFileSync(join(root, path))), expected);
  }
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
// Only Windows platform configuration is varied. No credential or provider values
// are inherited, and no environment values are serialized into the observations.
const platformNames = [
  "PSMODULEPATH",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "COMMONPROGRAMW6432",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "OS",
  "PUBLIC",
  "ALLUSERSPROFILE",
  "PROGRAMDATA",
];
if (label === "platform") for (const name of platformNames) permitted.add(name);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => permitted.has(name.toUpperCase())),
);
const home = join(privateDirectory, "home");
const temp = join(privateDirectory, "temp");
mkdirSync(home);
mkdirSync(temp);
Object.assign(environment, { HOME: home, USERPROFILE: home, TEMP: temp, TMP: temp, TMPDIR: temp });
for (const [name, directory] of Object.entries({
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  APPDATA: "appdata",
  LOCALAPPDATA: "localappdata",
})) {
  environment[name] = join(home, directory);
  mkdirSync(environment[name]);
}
let fixtureInstalled = false;
const failures = [];
const fixturePath = join(root, pins.testPath);
const assertFixture = () => {
  const bytes = readFileSync(fixturePath);
  assert.equal(blob(bytes), pins.fixtureBlob);
  assert.equal(hash(bytes), pins.fixtureSha256);
};
try {
  sourceGuard("before");
  save("provenance.json", {
    label,
    source,
    driver: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    pins,
    node: process.version,
    sourceLockSha256: hash(readFileSync(join(root, "bun.lock"))),
    platformFields: platformNames.map((name) => ({
      name,
      retained: Object.keys(environment).some((key) => key.toUpperCase() === name),
      inheritedPresent: Object.keys(process.env).some((key) => key.toUpperCase() === name),
    })),
    driverFiles: driverPaths.map((path) => ({
      path,
      gitBlob: blob(readFileSync(join(driver, path))),
      sha256: hash(readFileSync(join(driver, path))),
    })),
    qualification:
      "Read-only production Win32_Process workers under Node/Vitest. Minimal environment matches the failed native driver; platform adds named standard Windows variables only. No process rows, command strings or environment values are serialized. Original native comparison failures remain unchanged. No provider, teardown, GUI or worker-exit proof is claimed.",
  });
  const fixture = readFileSync(join(scripts, "WorkerEnvironment.native.test.ts"));
  assert.equal(blob(fixture), pins.fixtureBlob);
  assert.equal(hash(fixture), pins.fixtureSha256);
  writeFileSync(fixturePath, fixture, { flag: "wx" });
  fixtureInstalled = true;
  writeFileSync(join(output, "WorkerEnvironment.native.test.ts"), fixture);
  assertFixture();
  try {
    await observe(
      "worker",
      process.execPath,
      [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        "src/provider/Layers/WorkerEnvironment.native.test.ts",
        "--reporter=verbose",
        "--reporter=json",
        "--outputFile=" + join(live, "worker.json"),
      ],
      {
        cwd: join(root, "apps/server"),
        timeoutMs: 90_000,
        env: {
          ...environment,
          SYNARA_WORKER_ENV_DIAGNOSTIC: "1",
          WORKER_ENV_MODE: label,
          WORKER_ENV_SOURCE: source.head,
          WORKER_ENV_EVIDENCE: live,
        },
      },
    );
  } finally {
    freeze("worker.json");
    freeze("events.ndjson");
  }
  const report = JSON.parse(readFileSync(join(output, "worker.json"), "utf8"));
  assert.equal(report.numTotalTests, 1);
  assert.equal(report.numPassedTests, 1);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.success, true);
  const events = readFileSync(join(output, "events.ndjson"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.filter((event) => event.kind === "default-result").length, 4);
  assert.equal(events.filter((event) => event.kind === "prepared-result").length, 2);
  assert.equal(events.filter((event) => event.kind === "raw-result").length, 1);
  assert.equal(
    events.filter((event) => event.kind === "diagnostic-result" && event.passed).length,
    1,
  );
} catch (error) {
  failures.push(String(error));
} finally {
  try {
    if (fixtureInstalled) {
      assertFixture();
      unlinkSync(fixturePath);
      fixtureInstalled = false;
    }
    sourceGuard("after");
  } catch (error) {
    failures.push(String(error));
  }
  // Preserve test accounting even when observe already threw for its real exit.
  try {
    if (existsSync(join(output, "worker.json"))) {
      const report = JSON.parse(readFileSync(join(output, "worker.json"), "utf8"));
      save("test-accounting.json", {
        success: report.success,
        total: report.numTotalTests,
        passed: report.numPassedTests,
        failed: report.numFailedTests,
        pending: report.numPendingTests,
        tests: report.testResults.flatMap((suite) => suite.assertionResults),
      });
    }
  } catch (error) {
    failures.push(String(error));
  }
  save("snapshots.json", [...snapshots.values()]);
  save("result.json", { passed: failures.length === 0, failures });
  const manifest = readdirSync(output)
    .filter((name) => name !== "evidence-manifest.json")
    .sort()
    .map((name) => {
      const bytes = readFileSync(join(output, name));
      return { name, bytes: bytes.length, sha256: hash(bytes) };
    });
  save("evidence-manifest.json", manifest);
}
if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
}

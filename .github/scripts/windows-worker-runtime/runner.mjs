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
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

assert.equal(process.env.GITHUB_ACTIONS, "true", "Use an isolated hosted runner");
assert.equal(process.platform, "win32");
assert.ok(process.env.GITHUB_WORKSPACE && process.env.RUNNER_TEMP);
const root = resolve(process.env.GITHUB_WORKSPACE, "source");
const driver = resolve(process.env.GITHUB_WORKSPACE, "driver");
const scripts = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(scripts, "pins.json"), "utf8"));
const label = process.env.WORKER_RUNTIME;
assert.ok(label === "node" || label === "bun");
const source = pins.source;
const output = join(resolve(process.env.RUNNER_TEMP), "windows-worker-runtime-evidence");
const privateDirectory = join(resolve(process.env.RUNNER_TEMP), "windows-worker-runtime-private");
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
  ".github/workflows/windows-worker-runtime.yml",
  ".github/scripts/windows-worker-runtime/runner.mjs",
  ".github/scripts/windows-worker-runtime/pins.json",
  ".github/scripts/windows-worker-runtime/build.mjs",
  ".github/scripts/windows-worker-runtime/WorkerRuntime.probe.ts",
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
  assert.equal(existsSync(join(root, pins.probePath)), false);
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
  ...platformNames,
]);
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => permitted.has(name.toUpperCase())),
);
const home = join(privateDirectory, "home");
const temp = join(privateDirectory, "temp");
const working = join(privateDirectory, "cwd");
const cache = join(privateDirectory, "powershell-cache", "ModuleAnalysisCache");
for (const directory of [home, temp, working, dirname(cache)])
  mkdirSync(directory, { recursive: true });
Object.assign(environment, {
  HOME: home,
  USERPROFILE: home,
  TEMP: temp,
  TMP: temp,
  TMPDIR: temp,
  HOMEDRIVE: win32.parse(home).root.replace(/\\$/u, ""),
  HOMEPATH: home.slice(win32.parse(home).root.length - 1),
  // Set a real writable cache file before PowerShell starts. Do not disable caching.
  PSModuleAnalysisCachePath: cache,
});
for (const [name, directory] of Object.entries({
  XDG_CONFIG_HOME: "config",
  XDG_DATA_HOME: "data",
  XDG_CACHE_HOME: "cache",
  XDG_STATE_HOME: "state",
  APPDATA: "AppData/Roaming",
  LOCALAPPDATA: "AppData/Local",
})) {
  environment[name] = join(home, directory);
  mkdirSync(environment[name], { recursive: true });
}
const probePath = join(root, pins.probePath);
const bundlePath = join(live, "probe.mjs");
let probeInstalled = false;
let bundleSha256;
const failures = [];
const assertProbe = () => {
  const bytes = readFileSync(probePath);
  assert.equal(blob(bytes), pins.probeBlob);
  assert.equal(hash(bytes), pins.probeSha256);
};
try {
  sourceGuard("before");
  save("provenance.json", {
    label,
    source,
    driver: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    pins,
    runnerNode: process.version,
    sourceLockSha256: hash(readFileSync(join(root, "bun.lock"))),
    platformFields: platformNames.map((name) => ({
      name,
      retained: Object.keys(environment).some((key) => key.toUpperCase() === name),
      inheritedPresent: Object.keys(process.env).some((key) => key.toUpperCase() === name),
    })),
    privateCwd: true,
    privateProfile: true,
    explicitWritablePowerShellCache: true,
    driverFiles: driverPaths.map((path) => ({
      path,
      gitBlob: blob(readFileSync(join(driver, path))),
      sha256: hash(readFileSync(join(driver, path))),
    })),
    qualification:
      "Identical standalone Node-target bundle of seven exact production source files and one probe, under Node or Bun. No dependency install or provider execution. Private cwd/profile and explicit writable PowerShell module-cache path are held constant. Original default3s/prepared policies and separate15s raw bound remain. Only counts, fixed markers and actual owned-child events are recorded; no process rows, commands or environment values. This does not establish provider or descendant teardown.",
  });
  const probe = readFileSync(join(scripts, "WorkerRuntime.probe.ts"));
  assert.equal(blob(probe), pins.probeBlob);
  assert.equal(hash(probe), pins.probeSha256);
  writeFileSync(probePath, probe, { flag: "wx" });
  probeInstalled = true;
  writeFileSync(join(output, "WorkerRuntime.probe.ts"), probe);
  try {
    await observe("build", "bun", [join(scripts, "build.mjs"), root, live], {
      cwd: working,
      env: environment,
      timeoutMs: 30_000,
    });
  } finally {
    freeze("probe.mjs");
    freeze("build-metadata.json");
    assertProbe();
    unlinkSync(probePath);
    probeInstalled = false;
  }
  sourceGuard("after-build");
  const metadata = JSON.parse(readFileSync(join(output, "build-metadata.json"), "utf8"));
  assert.equal(
    metadata.compiler,
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager.slice(4),
  );
  bundleSha256 = metadata.bundleSha256;
  assert.equal(
    bundleSha256,
    pins.bundleSha256,
    "Both runtimes must execute the reviewed identical bundle bytes",
  );
  assert.equal(hash(readFileSync(bundlePath)), bundleSha256);
  assert.equal(hash(readFileSync(join(output, "probe.mjs"))), bundleSha256);
  try {
    await observe("worker", label === "node" ? process.execPath : "bun", [bundlePath], {
      cwd: working,
      timeoutMs: 90_000,
      env: {
        ...environment,
        SYNARA_WORKER_RUNTIME_DIAGNOSTIC: "1",
        WORKER_RUNTIME: label,
        WORKER_RUNTIME_SOURCE: source.head,
        WORKER_RUNTIME_EVIDENCE: live,
      },
    });
  } finally {
    freeze("events.ndjson");
  }
} catch (error) {
  failures.push(String(error));
} finally {
  try {
    if (probeInstalled) {
      assertProbe();
      unlinkSync(probePath);
      probeInstalled = false;
    }
    sourceGuard("after");
    if (bundleSha256) assert.equal(hash(readFileSync(bundlePath)), bundleSha256);
  } catch (error) {
    failures.push(String(error));
  }
  // Preserve all seven real results even when the subprocess itself failed.
  try {
    freeze("events.ndjson");
    const events = readFileSync(join(output, "events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const qualified = events.filter((event) => event.kind === "qualification");
    assert.equal(qualified.length, 1);
    assert.equal(qualified[0].source, source.head);
    assert.equal(qualified[0].runtime, label);
    assert.equal(qualified[0].defaultQueryTimeoutMs, 3_000);
    assert.equal(qualified[0].rawControlDeadlineMs, 15_000);
    if (label === "bun")
      assert.equal(
        qualified[0].bun,
        JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager.slice(4),
      );
    else assert.equal(qualified[0].bun, null);
    const defaults = events.filter((event) => event.kind === "default-result");
    const prepared = events.filter((event) => event.kind === "prepared-result");
    const raw = events.filter((event) => event.kind === "raw-result");
    const terminal = events.filter((event) => event.kind === "diagnostic-result");
    save("case-accounting.json", { defaults, prepared, raw, terminal });
    assert.equal(defaults.length, 4);
    assert.equal(prepared.length, 2);
    assert.equal(raw.length, 1);
    assert.equal(terminal.length, 1);
    assert.ok(defaults.every((event) => event.complete));
    assert.ok(prepared.every((event) => event.complete));
    assert.equal(raw[0].outcome, "snapshot");
    assert.equal(terminal[0].passed, true);
    assert.ok(
      events
        .filter((event) => event.kind === "child-byte-counts")
        .every((event) => event.discardedLongLines === 0),
    );
  } catch (error) {
    failures.push(String(error));
  }
  try {
    save("cache-observation.json", {
      explicitOwnedCache: existsSync(cache)
        ? { present: true, regularFile: statSync(cache).isFile(), bytes: statSync(cache).size }
        : { present: false },
      boundary:
        "Cache contents are not captured; this is file metadata only, not a worker-success inference.",
    });
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

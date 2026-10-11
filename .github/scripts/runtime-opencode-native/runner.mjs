import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const scripts = dirname(fileURLToPath(import.meta.url));
const pins = JSON.parse(readFileSync(join(scripts, "pins.json"), "utf8"));
assert.equal(process.env.GITHUB_ACTIONS, "true", "Use an isolated hosted runner");
assert.ok(process.env.RUNNER_TEMP);
const output = join(resolve(process.env.RUNNER_TEMP), "runtime-opencode-native-evidence");
const privateDirectory = join(resolve(process.env.RUNNER_TEMP), "runtime-opencode-native-private");
mkdirSync(output, { recursive: true });
mkdirSync(privateDirectory);
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
const driverPaths = [
  ".github/workflows/runtime-opencode-native.yml",
  ".github/scripts/runtime-opencode-native/runner.mjs",
  ".github/scripts/runtime-opencode-native/extract.py",
  ".github/scripts/runtime-opencode-native/pins.json",
];

function sourceGuard(phase) {
  const commands = [
    ["rev-parse", "HEAD"],
    ["rev-parse", pins.sourceHead + "^{tree}"],
    ["status", "--porcelain=v1", "--untracked-files=all"],
    ["diff", "--exit-code", "HEAD", "--"],
    ["diff", "--exit-code", pins.sourceHead, "--", ".", ...driverPaths.map((p) => ":!" + p)],
  ];
  const results = commands.map((args) => {
    const result = spawnSync("git", args, {
      cwd: root,
      shell: false,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      args,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  });
  save("source-" + phase + ".json", {
    source: pins.sourceHead,
    driver: process.env.GITHUB_SHA,
    results,
  });
  for (const result of results) {
    assert.equal(result.error, null);
    assert.equal(result.status, 0, JSON.stringify(result));
  }
  assert.equal(results[0].stdout.trim(), process.env.GITHUB_SHA);
  assert.equal(results[1].stdout.trim(), pins.sourceTree);
  assert.equal(results[2].stdout.trim(), "", "The entire worktree must stay clean");
  assert.equal(blob(readFileSync(join(root, pins.liveTest))), pins.liveTestBlob);
  assert.equal(
    JSON.parse(readFileSync("apps/server/package.json", "utf8")).dependencies["@opencode/client"],
    pins.version,
  );
}

// File descriptors avoid a descendant-held pipe hiding the root exit. A deadline
// signals only the still-live ChildProcess handle; it does not prove descendant cleanup.
async function observe(name, command, args, { cwd = root, env, timeoutMs }) {
  const log = join(output, name + ".log");
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
    result.logBytes = readFileSync(log).length;
    result.logSha256 = hash(readFileSync(log));
    save(name + "-process.json", result);
  }
  assert.equal(result.deadline, false, name + " exceeded its observation deadline");
  assert.equal(result.closeObserved, true, name + " did not close");
  assert.deepEqual(result.processErrors, []);
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

const failures = [];
let executedBinary;
let executedBinarySha256;
try {
  sourceGuard("before");
  save("provenance.json", {
    source: pins.sourceHead,
    sourceTree: pins.sourceTree,
    driver: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    platform,
    pins,
    driverFiles: driverPaths.map((path) => ({
      path,
      sha256: hash(readFileSync(path)),
      gitBlob: blob(readFileSync(path)),
    })),
    qualification:
      "Real managed native OpenCode CLI and the exact opted-in public-adapter test. The author's explicitly selected public model is attempted with no injected provider credentials. Availability/authentication failures remain failures. This is not a ProviderService/reactor timing, all-provider, native process-tree-exit or authenticated-account qualification.",
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
  const extracted = JSON.parse(readFileSync(join(output, "extract.log"), "utf8"));
  save("extraction.json", extracted);
  const binary = extracted.executable;
  assert.equal(
    resolve(binary),
    join(privateDirectory, "extracted", platform === "windows-x64" ? "opencode.exe" : "opencode"),
  );
  const binarySha256 = hash(readFileSync(binary));
  assert.equal(
    binarySha256,
    extracted.members.find((entry) => entry.path.includes("/bin/")).sha256,
  );
  executedBinary = binary;
  executedBinarySha256 = binarySha256;
  save("binary-before.json", { path: binary, sha256: binarySha256, version: pins.version });
  // Keep normal OS homes and process paths; omit provider/account credentials,
  // external-server overrides and arbitrary inherited OpenCode configuration.
  const permitted = new Set([
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "LANG",
    "LC_ALL",
    "TERM",
    "CI",
    "NODE_OPTIONS",
  ]);
  const nativeEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => permitted.has(name.toUpperCase())),
  );
  await observe("version", binary, ["--version"], { env: nativeEnvironment, timeoutMs: 30_000 });
  assert.equal(readFileSync(join(output, "version.log"), "utf8").trim(), pins.version);
  sourceGuard("before-native");
  await observe(
    "native",
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "src/provider/Layers/OpenCodeAdapter.live.test.ts",
      "--reporter=verbose",
      "--reporter=json",
      "--outputFile=" + join(output, "native.json"),
    ],
    {
      cwd: join(root, "apps/server"),
      timeoutMs: 240_000,
      env: {
        ...nativeEnvironment,
        SYNARA_LIVE_OPENCODE: "1",
        OPENCODE_LIVE_BINARY: binary,
        OPENCODE_LIVE_MODEL: pins.model,
      },
    },
  );
  const report = JSON.parse(readFileSync(join(output, "native.json"), "utf8"));
  assert.equal(report.success, true);
  assert.equal(report.numTotalTests, 1);
  assert.equal(report.numPassedTests, 1);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPendingTests, 0);
  const assertions = report.testResults.flatMap((suite) => suite.assertionResults);
  assert.equal(assertions.length, 1);
  assert.equal(assertions[0].status, "passed");
  assert.match(
    assertions[0].fullName,
    /isolates real native sessions and observes cancellation through replacement completion/,
  );
  assert.equal(
    hash(readFileSync(binary)),
    binarySha256,
    "The executed native binary must remain unchanged",
  );
  save("native-qualification.json", {
    source: pins.sourceHead,
    liveTestBlob: pins.liveTestBlob,
    binarySha256,
    model: pins.model,
    passedTests: 1,
    skippedTests: 0,
    boundary:
      "The exact author adapter fixture observed real output, an aborted first turn, isolated replacement completion, idempotent stop and a generation-owned event fence. No broader native process-exit inference.",
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
    sourceGuard("after");
  } catch (error) {
    failures.push(String(error));
  }
  save("result.json", { passed: failures.length === 0, failures });
  if (failures.length) process.exitCode = 1;
}

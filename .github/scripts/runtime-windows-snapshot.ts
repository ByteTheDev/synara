import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createPowerShellProcessSnapshotWorker,
  createWindowsProcessSnapshotObserver,
  type ProcessChildrenSnapshotWorker,
} from "../../apps/server/src/platform/windowsProcessSnapshot.ts";

const sourceHead = "a357c6a7022c33c61f77e594da3ba57b9d1dd0e1";
const sourceTree = "d322fe2ce0b0853b1e0d7ddba0d449fde22967c6";
const driverPaths = [
  ".github/workflows/runtime-windows-snapshot.yml",
  ".github/scripts/runtime-windows-snapshot.ts",
];
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.platform, "win32");
assert.ok(process.env.RUNNER_TEMP);
const output = join(resolve(process.env.RUNNER_TEMP), "runtime-windows-snapshot-evidence");
mkdirSync(output);
const save = (name: string, value: unknown) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
const origin = performance.now();
const events: Array<Record<string, unknown>> = [];
const record = (kind: string, fields: Record<string, unknown> = {}) => {
  const entry = { kind, elapsedMs: performance.now() - origin, ...fields };
  events.push(entry);
  appendFileSync(join(output, "events.ndjson"), JSON.stringify(entry) + "\n");
};
const errorDetail = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 512);

function assertSource(phase: string) {
  const commands = [
    ["rev-parse", "HEAD"],
    ["rev-parse", sourceHead + "^{tree}"],
    ["status", "--porcelain=v1", "--untracked-files=all"],
    ["diff", "--exit-code", "HEAD", "--"],
    ["diff", "--exit-code", sourceHead, "--", ".", ...driverPaths.map((p) => ":!" + p)],
  ];
  const results = commands.map((args) => {
    const result = spawnSync("git", args, {
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
      stdout: result.stdout,
      stderr: result.stderr,
    };
  });
  save("source-" + phase + ".json", results);
  for (const result of results) {
    assert.equal(result.error, null);
    assert.equal(result.status, 0, JSON.stringify(result));
  }
  assert.equal(results[0]!.stdout.trim(), process.env.GITHUB_SHA);
  assert.equal(results[1]!.stdout.trim(), sourceTree);
  assert.equal(results[2]!.stdout.trim(), "");
}

// Only aggregate row counts and the worker's bounded generic failure are
// recorded. The process table's command strings never enter logs or artifacts.
function observeWorker(sample: string): ProcessChildrenSnapshotWorker {
  const worker = createPowerShellProcessSnapshotWorker();
  record("worker-created", { sample });
  return {
    capture: async () => {
      const started = performance.now();
      record("worker-capture-start", { sample });
      try {
        const snapshot = await worker.capture();
        record("worker-capture-end", {
          sample,
          outcome: "snapshot",
          durationMs: performance.now() - started,
          parentCount: snapshot.size,
          processCount: [...snapshot.values()].reduce(
            (count, children) => count + children.length,
            0,
          ),
        });
        return snapshot;
      } catch (error) {
        record("worker-capture-end", {
          sample,
          outcome: "error",
          durationMs: performance.now() - started,
          error: errorDetail(error),
        });
        throw error;
      }
    },
    dispose: () => {
      record("worker-dispose-requested", { sample });
      worker.dispose();
    },
  };
}

const failures: string[] = [];
try {
  assertSource("before");
  const snapshotSource = readFileSync("apps/server/src/platform/windowsProcessSnapshot.ts");
  save("provenance.json", {
    sourceHead,
    sourceTree,
    driver: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    bun: Bun.version,
    sourceSha256: createHash("sha256").update(snapshotSource).digest("hex"),
    defaultObserverTimeoutMs: 3000,
    rawWorkerControlDeadlineMs: 15000,
    scope:
      "Actual production worker and default observer; read-only Win32_Process queries. No provider start, teardown, archive execution, or timeout policy modification.",
    cleanup:
      "The production worker disposes its owned ChildProcess handle. Worker/root/descendant exit is not inferred from the dispose call.",
    privacy:
      "Process table rows, command strings, environment values and credentials are not serialized.",
  });
  for (let index = 1; index <= 3; index += 1) {
    const sample = "default-observer-" + index;
    const observer = createWindowsProcessSnapshotObserver({
      createWorker: () => observeWorker(sample),
    });
    try {
      for (const temperature of ["fresh-worker", "same-worker"] as const) {
        const started = performance.now();
        const snapshot = await observer.capture();
        record("default-observer-result", {
          sample,
          temperature,
          outcome: snapshot === null ? "unavailable" : "snapshot",
          durationMs: performance.now() - started,
          retryDelayMs: observer.retryDelayMs(),
        });
        if (snapshot === null) {
          failures.push(sample + "/" + temperature + " did not return a complete snapshot");
          break;
        }
      }
    } finally {
      observer.dispose();
    }
  }
  // This control measures the unchanged worker without the outer three-second
  // observer. Its separate deadline does not change the production observer.
  const rawWorker = observeWorker("raw-worker-control");
  let expired = false;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    deadline = setTimeout(() => {
      expired = true;
      rawWorker.dispose();
    }, 15000);
    const snapshot = await rawWorker.capture();
    record("raw-worker-control-result", { expired, snapshot: true, parentCount: snapshot.size });
    if (expired) failures.push("raw worker returned only after its diagnostic deadline");
  } catch (error) {
    record("raw-worker-control-result", { expired, snapshot: false, error: errorDetail(error) });
    failures.push("raw worker control failed: " + errorDetail(error));
  } finally {
    clearTimeout(deadline);
    rawWorker.dispose();
  }
} catch (error) {
  failures.push(errorDetail(error));
} finally {
  try {
    assertSource("after");
  } catch (error) {
    failures.push(errorDetail(error));
  }
  save("result.json", { passed: failures.length === 0, failures, events });
  if (failures.length > 0) process.exitCode = 1;
}

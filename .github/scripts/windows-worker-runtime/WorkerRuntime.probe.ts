// Read-only diagnostic of exact production workers. No provider or exit-proof claim.
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPowerShellProcessSnapshotWorker,
  createPreparedWindowsTeardownProcessSnapshotObserver,
  createWindowsProcessSnapshotObserver,
  type ProcessChildrenSnapshotWorker,
} from "./windowsProcessSnapshot.ts";

type RecordObservation = (kind: string, fields: Record<string, unknown>) => void;

// The pinned class owns an ordinary private child property. These listeners read
// that exact child; they do not replace spawn, stream, stdin, signal or exit APIs.
export function observeWorkerChild(
  worker: ProcessChildrenSnapshotWorker,
  record: RecordObservation,
): () => void {
  const child = (worker as unknown as { child: ChildProcessWithoutNullStreams }).child;
  assert.ok(child?.stdout && child.stderr && child.stdin);
  const counts = {
    stdoutBytes: 0,
    stderrBytes: 0,
    startMarkers: 0,
    endMarkers: 0,
    errorMarkers: 0,
    otherLines: 0,
    discardedLongLines: 0,
  };
  let carry = "";
  let discarding = false;
  const emitCounts = () =>
    record("child-byte-counts", { ...counts, partialLineBytes: Buffer.byteLength(carry) });
  child.once("spawn", () => record("child-spawn-observed", {}));
  child.once("exit", (code, signal) => record("child-exit-observed", { code, signal }));
  child.once("close", (code, signal) => {
    emitCounts();
    record("child-close-observed", { code, signal });
  });
  child.once("error", (error: NodeJS.ErrnoException) => {
    record("child-error-observed", {
      code:
        typeof error.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)
          ? error.code
          : "unclassified",
    });
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    counts.stderrBytes += Buffer.byteLength(chunk);
  });
  child.stdout.on("data", (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    counts.stdoutBytes += Buffer.byteLength(chunk);
    for (const [index, part] of text.split("\n").entries()) {
      if (index > 0) {
        if (!discarding) {
          const line = carry.replace(/\r$/u, "");
          if (line === "@snapshot") counts.startMarkers += 1;
          else if (line === "@end") counts.endMarkers += 1;
          else if (line === "@error") counts.errorMarkers += 1;
          else counts.otherLines += 1;
        }
        carry = "";
        discarding = false;
      }
      if (!discarding) {
        if (Buffer.byteLength(carry) + Buffer.byteLength(part) > 131_072) {
          counts.discardedLongLines += 1;
          carry = "";
          discarding = true;
        } else carry += part;
      }
    }
  });
  return emitCounts;
}

export async function runProbe(): Promise<void> {
  assert.equal(process.platform, "win32");
  const output = process.env.WORKER_RUNTIME_EVIDENCE;
  assert.ok(output);
  const origin = performance.now();
  const record: RecordObservation = (kind, fields) =>
    appendFileSync(
      join(output, "events.ndjson"),
      JSON.stringify({ kind, elapsedMs: performance.now() - origin, ...fields }) + "\n",
    );
  const failures: string[] = [];
  let nextWorkerId = 0;
  const createWorker = (label: string): ProcessChildrenSnapshotWorker => {
    const worker = createPowerShellProcessSnapshotWorker();
    const workerId = ++nextWorkerId;
    let emitCounts: () => void;
    try {
      emitCounts = observeWorkerChild(worker, (kind, fields) =>
        record(kind, { label, workerId, ...fields }),
      );
      record("worker-created", { label, workerId });
    } catch (error) {
      worker.dispose();
      throw error;
    }
    return {
      capture: async () => {
        const started = performance.now();
        record("worker-capture-start", { label, workerId });
        try {
          const snapshot = await worker.capture();
          record("worker-capture-end", {
            label,
            workerId,
            durationMs: performance.now() - started,
            outcome: "snapshot",
            parentCount: snapshot.size,
            processCount: [...snapshot.values()].reduce((sum, rows) => sum + rows.length, 0),
          });
          return snapshot;
        } catch (error) {
          record("worker-capture-end", {
            label,
            workerId,
            durationMs: performance.now() - started,
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },
      dispose: () => {
        try {
          emitCounts();
          record("worker-dispose-requested", { label, workerId });
        } finally {
          worker.dispose();
        }
      },
    };
  };
  record("qualification", {
    source: process.env.WORKER_RUNTIME_SOURCE,
    runtime: process.env.WORKER_RUNTIME,
    node: process.version,
    bun: (process.versions as Record<string, string | undefined>).bun ?? null,
    defaultQueryTimeoutMs: 3_000,
    rawControlDeadlineMs: 15_000,
    nativeProvider: false,
    exitProof: false,
    scope:
      "Same standalone production-source bundle; counts and owned child events only. Disposal is not exit proof.",
  });
  for (let index = 0; index < 2; index += 1) {
    const label = `default-${index + 1}`;
    const observer = createWindowsProcessSnapshotObserver({
      createWorker: () => createWorker(label),
    });
    try {
      for (const temperature of ["fresh-worker", "same-observer"] as const) {
        const delay = observer.retryDelayMs();
        assert.ok(delay <= 30_000);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        const started = performance.now();
        const snapshot = await observer.capture();
        record("default-result", {
          label,
          temperature,
          durationMs: performance.now() - started,
          complete: snapshot !== null,
          retryDelayMs: observer.retryDelayMs(),
        });
        if (snapshot === null) failures.push(`${label}/${temperature} returned no snapshot`);
      }
    } finally {
      observer.dispose();
    }
  }
  const prepared = createPreparedWindowsTeardownProcessSnapshotObserver({
    createWorker: () => createWorker("prepared"),
  });
  try {
    // Controlled lead time is identical in both runtimes, not native readiness.
    await new Promise((resolve) => setTimeout(resolve, 350));
    for (let index = 0; index < 2; index += 1) {
      const started = performance.now();
      const snapshot = await prepared.captureWithin(3_000);
      record("prepared-result", {
        index,
        controlledPreparationLeadMs: 350,
        durationMs: performance.now() - started,
        complete: snapshot !== null,
      });
      if (snapshot === null) failures.push(`prepared-${index + 1} returned no snapshot`);
    }
  } finally {
    prepared.dispose();
  }
  const raw = createWorker("raw-control");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      raw.capture().then(
        () => "snapshot" as const,
        () => "error" as const,
      ),
      new Promise<"deadline">((resolve) => {
        timer = setTimeout(() => resolve("deadline"), 15_000);
      }),
    ]);
    record("raw-result", { outcome, deadlineMs: 15_000 });
    if (outcome !== "snapshot") failures.push(`raw control returned ${outcome}`);
  } finally {
    clearTimeout(timer);
    raw.dispose();
  }
  record("diagnostic-result", { passed: failures.length === 0, failures });
  assert.deepEqual(failures, []);
}

if (process.env.SYNARA_WORKER_RUNTIME_DIAGNOSTIC === "1") await runProbe();

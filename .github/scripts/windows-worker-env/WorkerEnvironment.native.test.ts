// Read-only diagnostic. Production workers query Win32_Process; rows are never serialized.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPowerShellProcessSnapshotWorker,
  createPreparedWindowsTeardownProcessSnapshotObserver,
  createWindowsProcessSnapshotObserver,
  type ProcessChildrenSnapshotWorker,
} from "../../platform/windowsProcessSnapshot.ts";

describe.runIf(process.env.SYNARA_WORKER_ENV_DIAGNOSTIC === "1")(
  "actual Windows snapshot worker environment",
  () => {
    it("retains every actual fresh, reused, prepared and bounded raw outcome", async () => {
      assert.equal(process.platform, "win32");
      const output = process.env.WORKER_ENV_EVIDENCE;
      assert.ok(output);
      const origin = performance.now();
      const record = (kind: string, fields: Record<string, unknown> = {}) =>
        appendFileSync(
          join(output, "events.ndjson"),
          JSON.stringify({ kind, elapsedMs: performance.now() - origin, ...fields }) + "\n",
        );
      const failures: string[] = [];
      let nextWorkerId = 0;
      const createWorker = (label: string): ProcessChildrenSnapshotWorker => {
        const worker = createPowerShellProcessSnapshotWorker();
        const workerId = ++nextWorkerId;
        try {
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
              record("worker-dispose-requested", { label, workerId });
            } finally {
              worker.dispose();
            }
          },
        };
      };
      record("qualification", {
        source: process.env.WORKER_ENV_SOURCE,
        environmentMode: process.env.WORKER_ENV_MODE,
        node: process.version,
        defaultQueryTimeoutMs: 3_000,
        rawControlDeadlineMs: 15_000,
        nativeProvider: false,
        exitProof: false,
        scope: "Actual production workers and policies; counts only. Dispose is not exit proof.",
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
        // This is controlled lead time, not a native readiness observation.
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
      expect(failures).toEqual([]);
    }, 60_000);
  },
);

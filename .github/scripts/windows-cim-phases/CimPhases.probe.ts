// Counts-only diagnostic of the pinned production PowerShell worker.
// Experimental EOF and command-resolution markers are not production repairs.
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { spawnProcess } from "@synara/shared/processRuntime";
import { resolveWindowsSystemRoot } from "@synara/shared/platformEnvironment";
import {
  createPowerShellProcessSnapshotWorker,
  type ProcessChildrenSnapshotWorker,
} from "./windowsProcessSnapshot.ts";

type RecordObservation = (kind: string, fields: Record<string, unknown>) => void;
type CommandPlan = { command: string; args: string[]; script: string };
const CASES = [
  "exact-open",
  "exact-eof",
  "phased-open",
  "phased-eof",
  "explicit-import-open",
  "system-module-path-open",
] as const;
const PHASES = new Set([
  "before-command-resolution",
  "before-explicit-import",
  "explicit-import-completed",
  "before-module-path-isolation",
  "module-path-isolated",
  "command-resolved",
  "before-query",
  "first-row",
  "query-completed",
  "catch-entered",
]);
const OBSERVATION_DEADLINE_MS = 15_000;
const CLOSE_DRAIN_MS = 5_000;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function childOf(worker: ProcessChildrenSnapshotWorker): ChildProcessWithoutNullStreams {
  const child = (worker as unknown as { child: ChildProcessWithoutNullStreams }).child;
  assert.ok(child?.stdout && child.stderr && child.stdin);
  return child;
}

// Read the actual production-owned child plan; never emit its arguments or rows.
export function productionPlan(child: ChildProcessWithoutNullStreams): CommandPlan {
  assert.equal(
    child.spawnfile.toLowerCase(),
    win32
      .join(resolveWindowsSystemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      .toLowerCase(),
  );
  assert.equal(child.spawnargs.length, 6);
  const args = child.spawnargs.slice(1);
  assert.deepEqual(args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
  ]);
  assert.match(args[4]!, /^[A-Za-z0-9+/]+={0,2}$/u);
  const script = Buffer.from(args[4]!, "base64").toString("utf16le");
  assert.equal(Buffer.from(script, "utf16le").toString("base64"), args[4]);
  return { command: child.spawnfile, args, script };
}

// The instrumented cases retain the complete original loop, request, query,
// row serialization and error/end markers. Only these reversible blocks differ.
export function withCimPhaseMarkers(original: string): string {
  const query = "    Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {\n";
  const replacement = [
    "    [Console]::Error.WriteLine('@phase:before-command-resolution')",
    "    [Console]::Error.Flush()",
    "    $null = Get-Command Get-CimInstance -ErrorAction Stop",
    "    [Console]::Error.WriteLine('@phase:command-resolved')",
    "    [Console]::Error.WriteLine('@phase:before-query')",
    "    [Console]::Error.Flush()",
    "    $seenRow = $false",
    query.trimEnd(),
    "      if (-not $seenRow) {",
    "        [Console]::Error.WriteLine('@phase:first-row')",
    "        [Console]::Error.Flush()",
    "        $seenRow = $true",
    "      }",
    "",
  ].join("\n");
  const end = "    [Console]::Out.WriteLine('@end')";
  const endReplacement =
    "    [Console]::Error.WriteLine('@phase:query-completed')\n" +
    "    [Console]::Error.Flush()\n" +
    end;
  const caught = "  } catch {\n";
  const caughtReplacement =
    caught +
    "    [Console]::Error.WriteLine('@phase:catch-entered')\n" +
    "    [Console]::Error.Flush()\n";
  for (const needle of [query, end, caught]) {
    assert.equal(original.split(needle).length, 2, "Expected one exact production marker");
  }
  const modified = original
    .replace(query, replacement)
    .replace(end, endReplacement)
    .replace(caught, caughtReplacement);
  assert.equal(
    modified
      .replace(replacement, query)
      .replace(endReplacement, end)
      .replace(caughtReplacement, caught),
    original,
    "Instrumentation must reverse to every original script byte",
  );
  return modified;
}

// These experiments alter only this owned PowerShell process. They preserve
// the already reviewed phase markers, complete original query and row protocol.
export function withSystemCimModuleResolution(
  phased: string,
  mode: "explicit-import" | "system-module-path",
): string {
  const marker = "    [Console]::Error.WriteLine('@phase:before-command-resolution')";
  const preparation =
    mode === "explicit-import"
      ? [
          "    [Console]::Error.WriteLine('@phase:before-explicit-import')",
          "    [Console]::Error.Flush()",
          "    $cimManifest = [System.IO.Path]::Combine($PSHOME, 'Modules\\CimCmdlets\\CimCmdlets.psd1')",
          "    if (-not [System.IO.File]::Exists($cimManifest)) { throw 'System CimCmdlets manifest is missing' }",
          "    Import-Module -Name $cimManifest -ErrorAction Stop",
          "    [Console]::Error.WriteLine('@phase:explicit-import-completed')",
          "    [Console]::Error.Flush()",
        ].join("\n")
      : [
          "    [Console]::Error.WriteLine('@phase:before-module-path-isolation')",
          "    [Console]::Error.Flush()",
          "    $env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')",
          "    [Console]::Error.WriteLine('@phase:module-path-isolated')",
          "    [Console]::Error.Flush()",
        ].join("\n");
  assert.equal(phased.split(marker).length, 2, "Exactly one reviewed resolution boundary");
  const replacement = preparation + "\n" + marker;
  const modified = phased.replace(marker, replacement);
  assert.equal(
    modified.replace(replacement, marker),
    phased,
    "Module experiment must reverse to all prior phase-instrumented bytes",
  );
  return modified;
}

export function observeWorkerChild(
  child: ChildProcessWithoutNullStreams,
  record: RecordObservation,
): () => void {
  const counts = {
    stdoutBytes: 0,
    stderrBytes: 0,
    startMarkers: 0,
    endMarkers: 0,
    errorMarkers: 0,
    otherStdoutLines: 0,
    otherStderrLines: 0,
    discardedLongLines: 0,
  };
  const readers = {
    stdout: { carry: "", discarding: false },
    stderr: { carry: "", discarding: false },
  };
  const emit = () =>
    record("child-byte-counts", {
      ...counts,
      partialStdoutBytes: Buffer.byteLength(readers.stdout.carry),
      partialStderrBytes: Buffer.byteLength(readers.stderr.carry),
    });
  const consume = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    counts[stream === "stdout" ? "stdoutBytes" : "stderrBytes"] += Buffer.byteLength(chunk);
    const reader = readers[stream];
    for (const [index, part] of text.split("\n").entries()) {
      if (index > 0) {
        if (!reader.discarding) {
          const line = reader.carry.replace(/\r$/u, "");
          if (stream === "stdout") {
            if (line === "@snapshot") counts.startMarkers += 1;
            else if (line === "@end") counts.endMarkers += 1;
            else if (line === "@error") counts.errorMarkers += 1;
            else counts.otherStdoutLines += 1;
          } else if (line.startsWith("@phase:") && PHASES.has(line.slice(7))) {
            record("cim-phase", { phase: line.slice(7) });
          } else counts.otherStderrLines += 1;
        }
        reader.carry = "";
        reader.discarding = false;
      }
      if (!reader.discarding) {
        if (Buffer.byteLength(reader.carry) + Buffer.byteLength(part) > 131_072) {
          counts.discardedLongLines += 1;
          reader.carry = "";
          reader.discarding = true;
        } else reader.carry += part;
      }
    }
  };
  child.stdout.on("data", (chunk: Buffer | string) => consume("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer | string) => consume("stderr", chunk));
  child.once("spawn", () => record("child-spawn-observed", {}));
  child.once("exit", (code, signal) => record("child-exit-observed", { code, signal }));
  child.once("close", (code, signal) => {
    emit();
    record("child-close-observed", { code, signal });
  });
  child.on("error", (error: NodeJS.ErrnoException) => {
    record("child-error-observed", {
      code:
        typeof error.code === "string" && /^[A-Z0-9_]+$/u.test(error.code)
          ? error.code
          : "unclassified",
    });
  });
  return emit;
}

export async function runProbe(): Promise<void> {
  assert.equal(process.platform, "win32");
  const output = process.env.WORKER_PHASES_EVIDENCE;
  assert.ok(output);
  const started = performance.now();
  const record: RecordObservation = (kind, fields) =>
    appendFileSync(
      join(output, "events.ndjson"),
      JSON.stringify({ kind, elapsedMs: performance.now() - started, ...fields }) + "\n",
    );
  const failures: string[] = [];
  let plan: CommandPlan | undefined;
  record("qualification", {
    source: process.env.WORKER_PHASES_SOURCE,
    runtime: process.env.WORKER_PHASES,
    node: process.version,
    bun: (process.versions as Record<string, string | undefined>).bun ?? null,
    defaultQueryTimeoutMs: 3_000,
    observationDeadlineMs: OBSERVATION_DEADLINE_MS,
    closeDrainMs: CLOSE_DRAIN_MS,
    cases: CASES,
    nativeProvider: false,
    exitProof: false,
    scope:
      "Unchanged production and phase/EOF controls, plus explicit trusted system CimCmdlets import and system-module-path isolation experiments. The 15s diagnostic bound does not change the 3s production policy. Only counts, fixed phases and actual owned-child exits are emitted.",
  });

  for (const id of CASES) {
    let worker: ProcessChildrenSnapshotWorker | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let emitCounts: (() => void) | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let forcedOutputCutoff = false;
    const began = performance.now();
    let outcome: "snapshot" | "capture-error" | "deadline" | "setup-error" = "setup-error";
    let processCount = 0;
    let closePromise: Promise<void> | undefined;
    let scriptSha256: string | null = null;
    try {
      if (id.startsWith("exact")) {
        worker = createPowerShellProcessSnapshotWorker();
        child = childOf(worker);
        const observed = productionPlan(child);
        if (plan) assert.deepEqual(observed, plan);
        else plan = observed;
        scriptSha256 = hash(observed.script);
      } else {
        assert.ok(plan, "No verified actual production command plan");
        const phased = withCimPhaseMarkers(plan.script);
        const script =
          id === "explicit-import-open"
            ? withSystemCimModuleResolution(phased, "explicit-import")
            : id === "system-module-path-open"
              ? withSystemCimModuleResolution(phased, "system-module-path")
              : phased;
        scriptSha256 = hash(script);
        const args = [...plan.args.slice(0, 4), Buffer.from(script, "utf16le").toString("base64")];
        const command = plan.command;
        worker = createPowerShellProcessSnapshotWorker({
          spawnProcess: () =>
            spawnProcess(command, args, {
              stdio: ["pipe", "pipe", "pipe"],
              platform: "win32",
            }),
        });
        child = childOf(worker);
      }
      emitCounts = observeWorkerChild(child, (kind, fields) => record(kind, { id, ...fields }));
      closePromise = new Promise<void>((resolve) => {
        child!.once("close", () => {
          closed = true;
          resolve();
        });
      });
      record("case-start", {
        id,
        instrumented: !id.startsWith("exact"),
        moduleResolution:
          id === "explicit-import-open"
            ? "explicit-system-manifest"
            : id === "system-module-path-open"
              ? "system-module-path-only"
              : "automatic",
        closeRequestInput: id.endsWith("eof"),
        scriptSha256,
        originalScriptSha256: plan ? hash(plan.script) : null,
        deadlineMs: OBSERVATION_DEADLINE_MS,
      });
      const capture = worker.capture().then(
        (snapshot) => {
          processCount = [...snapshot.values()].reduce((sum, rows) => sum + rows.length, 0);
          return "snapshot" as const;
        },
        () => "capture-error" as const,
      );
      // Preserve the production capture() request bytes and ordering. The EOF
      // variants explicitly close only that request pipe after its queued write.
      if (id.endsWith("eof")) {
        child.stdin.end();
        record("request-input-ended", { id });
      }
      outcome = await Promise.race([
        capture,
        new Promise<"deadline">((resolve) => {
          deadline = setTimeout(() => resolve("deadline"), OBSERVATION_DEADLINE_MS);
        }),
      ]);
      record("capture-result", {
        id,
        outcome,
        processCount,
        durationMs: performance.now() - began,
      });
    } catch {
      outcome = "setup-error";
      record("case-setup-error", { id });
    } finally {
      clearTimeout(deadline);
      emitCounts?.();
      record("worker-dispose-requested", { id });
      worker?.dispose();
      if (child && closePromise) {
        await Promise.race([
          closePromise,
          new Promise<void>((resolve) => {
            drain = setTimeout(resolve, CLOSE_DRAIN_MS);
          }),
        ]);
        clearTimeout(drain);
        if (!closed) {
          // The first production dispose already requested termination. Never
          // signal a numerical PID or infer its success. Release observation
          // resources after the bound and record the incomplete root observation.
          forcedOutputCutoff = true;
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
        }
      }
    }
    const complete = outcome === "snapshot" && processCount > 0 && closed && !forcedOutputCutoff;
    record("case-result", {
      id,
      outcome,
      processCount,
      complete,
      closeObserved: closed,
      forcedOutputCutoff,
      scriptSha256,
      durationMs: performance.now() - began,
      boundary:
        "Root exit/close is observed separately; provider and descendant cleanup is unproven.",
    });
    if (!complete) failures.push(id);
  }
  record("diagnostic-result", { passed: failures.length === 0, failures });
  assert.deepEqual(
    failures,
    [],
    "Keep every failed production or experimental observation visible",
  );
}

if (process.env.SYNARA_WORKER_PHASES_DIAGNOSTIC === "1") await runProbe();

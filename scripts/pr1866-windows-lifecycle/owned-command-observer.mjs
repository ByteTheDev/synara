import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, writeSync } from "node:fs";

const LOG_CAP_BYTES = 32 * 1024 * 1024;
const DEADLINE_MS = 30 * 60 * 1000;
const DRAIN_MS = 10 * 1000;
const now = () => new Date().toISOString();
const errorRecord = (error) => ({
  name: error.name,
  code: error.code ?? null,
  message: error.message,
});

// The complete observeCommand body below is byte-identical to the independently
// reviewed server-shard observer pinned in pins.json.
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


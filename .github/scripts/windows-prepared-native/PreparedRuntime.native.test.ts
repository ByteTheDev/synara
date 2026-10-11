// Diagnostic-only identical fixture for the two pinned production sources.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@synara/contracts";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { type ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect, it, vi } from "vitest";
import { ServerConfig } from "../../config.ts";
import { makeEffectProcessCommand } from "../../platform/effectProcessRuntime.ts";
import { defaultProcessTreeKiller } from "../../platform/processTreeController.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import {
  makeOpenCodeRuntimeLive,
  OpenCodeRuntime,
  OPENCODE_LOCAL_SERVER_IDLE_TTL_MS,
  type OpenCodeRuntimeLiveOptions,
} from "../opencodeRuntime.ts";
import { makeOpenCodeAdapterLive } from "./OpenCodeAdapter.ts";

const enabled = process.env.SYNARA_PREPARED_NATIVE === "1";
type Observation = Record<string, unknown>;
type OwnedChild = {
  handle: ChildProcessSpawner.ChildProcessHandle;
  pid: number;
  rawExit: "pending" | "success" | "failure";
  actualCode: number | null;
};
type ScenarioContext = {
  workspace: string;
  binary: string;
  children: OwnedChild[];
  record: (kind: string, fields?: Observation) => void;
};

function assertOwnedCommand(command: ChildProcess.Command, binary: string): void {
  assert.equal(command._tag, "StandardCommand");
  if (command._tag !== "StandardCommand") return;
  const args = command.args.slice(command.args.lastIndexOf("serve"));
  assert.equal(args.length, 5);
  assert.equal(args[0], "serve");
  assert.equal(args[1], "--hostname");
  assert.equal(args[2], "127.0.0.1");
  assert.equal(args[3], "--port");
  assert.ok(/^\d+$/u.test(args[4]!) && Number(args[4]) > 0 && Number(args[4]) < 65_536);
  assert.ok(
    [false, true].some((lowerPriority) => {
      const expected = makeEffectProcessCommand(binary, args, {
        ...command.options,
        lowerPriority,
      });
      return (
        expected._tag === "StandardCommand" &&
        expected.command === command.command &&
        expected.args.length === command.args.length &&
        expected.args.every((value, index) => value === command.args[index])
      );
    }),
    "Owned native command must match the real production priority planner",
  );
}

async function runOwned(
  name: string,
  scenario: (
    context: ScenarioContext,
  ) => Effect.Effect<void, unknown, OpenCodeRuntime | OpenCodeAdapter | Scope.Scope>,
  options?: Pick<OpenCodeRuntimeLiveOptions, "fetchImpl">,
) {
  const binary = process.env.OPENCODE_LIVE_BINARY;
  const evidence = process.env.PREPARED_NATIVE_EVIDENCE;
  const privateRoot = process.env.PREPARED_NATIVE_PRIVATE;
  assert.ok(binary && evidence && privateRoot);
  assert.equal(resolve(binary), binary);
  const workspace = mkdtempSync(join(privateRoot, name + "-"));
  mkdirSync(evidence, { recursive: true });
  const origin = performance.now();
  const record = (kind: string, fields: Observation = {}) =>
    appendFileSync(
      join(evidence, name + ".ndjson"),
      JSON.stringify({ kind, elapsedMs: performance.now() - origin, ...fields }) + "\n",
    );
  const children: OwnedChild[] = [];
  const signals: Array<{
    rootPid: number;
    signal: string;
    includeRootTree: boolean;
    captureComplete: boolean;
    descendantCount: number;
  }> = [];
  const observationScope = Effect.runSync(Scope.make());
  const watchers: Array<Fiber.Fiber<void, never>> = [];
  const observedSpawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        Effect.sync(() => assertOwnedCommand(command, binary)).pipe(
          Effect.andThen(spawner.spawn(command)),
          Effect.tap((handle) =>
            Effect.gen(function* () {
              const child: OwnedChild = {
                handle,
                pid: Number(handle.pid),
                rawExit: "pending",
                actualCode: null,
              };
              children.push(child);
              record("native-spawn", { pid: child.pid });
              const watcher = yield* handle.exitCode.pipe(
                Effect.exit,
                Effect.flatMap((exit) =>
                  Effect.sync(() => {
                    child.rawExit = Exit.isSuccess(exit) ? "success" : "failure";
                    child.actualCode = Exit.isSuccess(exit) ? Number(exit.value) : null;
                    record("actual-root-exit", {
                      pid: child.pid,
                      rawExit: child.rawExit,
                      actualCode: child.actualCode,
                    });
                  }),
                ),
                Effect.forkIn(observationScope),
              );
              watchers.push(watcher);
            }),
          ),
        ),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));
  // Do not inject teardownProcessTree or an observer factory: this exercises
  // the exact production preparation, capture, identity and cleanup policies.
  const runtimeLayer = makeOpenCodeRuntimeLive(options).pipe(Layer.provide(observedSpawner));
  const adapterLayer = Layer.unwrap(
    Effect.map(Effect.service(OpenCodeRuntime), (runtime) => makeOpenCodeAdapterLive({ runtime })),
  ).pipe(
    Layer.provideMerge(runtimeLayer),
    Layer.provideMerge(
      ServerConfig.layerTest(workspace, join(workspace, "state"), { homeDir: workspace }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
  const originalSignal = defaultProcessTreeKiller.signal;
  const signalObserver = vi
    .spyOn(defaultProcessTreeKiller, "signal")
    .mockImplementation((input) => {
      // The observation delegates every real signal once, including when logging
      // fails. No capture result, PID identity, signal argument or exit is replaced.
      try {
        if (children.some((child) => child.pid === input.rootPid)) {
          const observation = {
            rootPid: input.rootPid,
            signal: input.signal,
            includeRootTree: input.includeRootTree !== false,
            captureComplete: input.tree !== undefined && input.tree.captureComplete !== false,
            descendantCount: input.tree?.descendants.length ?? 0,
          };
          signals.push(observation);
          record("production-signal", observation);
        }
      } finally {
        originalSignal(input);
      }
    });
  const errors: unknown[] = [];
  try {
    record("qualification", {
      scenario: name,
      source: process.env.PREPARED_NATIVE_SOURCE,
      platform: process.platform,
      managedPoolIdleTtlMs: OPENCODE_LOCAL_SERVER_IDLE_TTL_MS,
      nativeInference: false,
      teardownOverride: false,
      scope: "Real production runtime and adapter; actual native HTTP readiness/session API",
      warmHold: "Measured one-second retention, not a five-minute expiry experiment",
    });
    const exit = await Effect.runPromiseExit(
      Effect.scoped(scenario({ workspace, binary, children, record })).pipe(
        Effect.provide(adapterLayer),
      ),
    );
    record("production-scope-exit", { exit: exit._tag });
    if (Exit.isFailure(exit)) errors.push(Cause.squash(exit.cause));
    try {
      await Effect.runPromise(
        Effect.forEach(watchers, Fiber.await, { concurrency: "unbounded" }).pipe(
          Effect.timeout(2_000),
        ),
      );
      expect(children).toHaveLength(1);
      for (const child of children) {
        expect(child.rawExit).toBe("success");
        expect(Number.isInteger(child.actualCode)).toBe(true);
        expect(await Effect.runPromise(child.handle.isRunning)).toBe(false);
        const firstSignal = signals.find((signal) => signal.rootPid === child.pid);
        expect(firstSignal).toBeDefined();
        expect(firstSignal?.captureComplete).toBe(true);
        expect(firstSignal?.includeRootTree).toBe(true);
      }
    } catch (error) {
      errors.push(error);
    }
  } catch (error) {
    errors.push(error);
  } finally {
    signalObserver.mockRestore();
    try {
      await Effect.runPromise(Scope.close(observationScope, Exit.void));
    } catch (error) {
      errors.push(error);
    }
    record("owned-exit-summary", {
      children: children.map(({ pid, rawExit, actualCode }) => ({ pid, rawExit, actualCode })),
      signals,
      errorCount: errors.length,
      passed: errors.length === 0,
      boundary:
        "Production scope completion plus actual raw root exits and complete pre-signal captured trees; no descendant result is synthesized. A failed production finalizer stays failed.",
    });
    // Keep private native workspaces for runner disposal; an unproven process
    // must not race recursive deletion. No private workspace is uploaded.
  }
  if (errors.length) throw new AggregateError(errors, "Native owned-runtime proof failed");
}

describe.runIf(enabled)("native prepared Windows observer comparison", () => {
  it("proves owned exit after immediate real native readiness", async () => {
    await runOwned("cold-ready", ({ workspace, binary, children, record }) =>
      Effect.gen(function* () {
        const runtime = yield* OpenCodeRuntime;
        yield* runtime.startOpenCodeServerProcess({ binaryPath: binary, cwd: workspace });
        expect(children).toHaveLength(1);
        expect(yield* children[0]!.handle.isRunning).toBe(true);
        record("native-readiness-confirmed", { pid: children[0]!.pid });
        record("scope-close-requested");
      }),
    );
  }, 90_000);

  it("retains a real managed runtime across stopped native sessions and warm reuse", async () => {
    await runOwned("session-warm-reuse", ({ workspace, binary, children, record }) =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const first = ThreadId.makeUnsafe("native-prepared-first");
        const second = ThreadId.makeUnsafe("native-prepared-second");
        const start = (threadId: ThreadId, generation: string) =>
          adapter.startSession({
            provider: "opencode",
            threadId,
            lifecycleGeneration: generation,
            cwd: workspace,
            runtimeMode: "approval-required",
            modelSelection: { provider: "opencode", model: "opencode/mimo-v2.6-flash-free" },
            providerOptions: { opencode: { binaryPath: binary } },
          });
        const firstSession = yield* start(first, "native-prepared-generation-first");
        expect(yield* adapter.hasSession(first)).toBe(true);
        expect(children).toHaveLength(1);
        const pid = children[0]!.pid;
        record("native-session-admitted", { ordinal: 1, pid });
        const stopStarted = performance.now();
        yield* adapter.stopSession(first);
        expect(yield* adapter.hasSession(first)).toBe(false);
        expect(yield* children[0]!.handle.isRunning).toBe(true);
        expect(children[0]!.rawExit).toBe("pending");
        record("adapter-stop-runtime-retained", {
          pid,
          durationMs: performance.now() - stopStarted,
        });
        const holdStarted = performance.now();
        yield* Effect.sleep(1_000);
        expect(yield* children[0]!.handle.isRunning).toBe(true);
        record("warm-hold-observed", { pid, durationMs: performance.now() - holdStarted });
        const secondSession = yield* start(second, "native-prepared-generation-second");
        expect(secondSession.resumeCursor).not.toEqual(firstSession.resumeCursor);
        expect(yield* adapter.hasSession(second)).toBe(true);
        expect(children).toHaveLength(1);
        expect(children[0]!.pid).toBe(pid);
        record("native-session-admitted", { ordinal: 2, pid });
        yield* adapter.stopAll();
        expect(yield* adapter.listSessions()).toEqual([]);
        expect(yield* children[0]!.handle.isRunning).toBe(true);
        record("scope-close-requested");
      }),
    );
  }, 120_000);

  it("proves owned exit when cancelled after an actual readiness response", async () => {
    const reachedReadiness = Deferred.makeUnsafe<void>();
    let held = false;
    await runOwned(
      "startup-cancellation",
      ({ workspace, binary, record }) =>
        Effect.gen(function* () {
          const runtime = yield* OpenCodeRuntime;
          const starting = yield* runtime
            .startOpenCodeServerProcess({ binaryPath: binary, cwd: workspace })
            .pipe(Effect.scoped, Effect.forkChild);
          try {
            yield* Deferred.await(reachedReadiness).pipe(Effect.timeout(30_000));
            record("caller-cancellation-requested-after-native-readiness");
            yield* Fiber.interrupt(starting);
            const interrupted = yield* Fiber.await(starting);
            expect(Exit.isFailure(interrupted)).toBe(true);
            if (Exit.isFailure(interrupted))
              expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
            record("caller-cancellation-completed");
          } finally {
            yield* Fiber.interrupt(starting);
          }
        }),
      {
        fetchImpl: async (url, init) => {
          const response = await fetch(url, init);
          if (!held && response.ok) {
            held = true;
            assert.ok(init?.signal);
            await Effect.runPromise(Deferred.succeed(reachedReadiness, undefined));
            try {
              await new Promise<never>((_, reject) => {
                const signal = init.signal!;
                const abort = () => reject(signal.reason);
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
              });
            } finally {
              await response.body?.cancel();
            }
          }
          return response;
        },
      },
    );
  }, 90_000);
});

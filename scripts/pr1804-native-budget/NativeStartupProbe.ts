// Diagnostic-only instrumentation. The source-pinned driver adds this file;
// it is not a production module and is never included in a feature repair.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@synara/contracts";
import { Deferred, Effect, Exit, Layer, Scope } from "effect";
import { vi } from "vitest";
import { type ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { makeEffectProcessCommand } from "../../platform/effectProcessRuntime.ts";
import { defaultProcessTreeKiller } from "../../platform/processTreeController.ts";
import { ProviderAdapterValidationError, ProviderUnsupportedError } from "../../provider/Errors.ts";
import { makeOpenCodeAdapterLive } from "../../provider/Layers/OpenCodeAdapter.ts";
import { makeDurableProviderServiceLive } from "../../provider/Layers/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import { OpenCodeAdapter } from "../../provider/Services/OpenCodeAdapter.ts";
import { ProviderAdapterRegistry } from "../../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  makeOpenCodeRuntimeLive,
  OPENCODE_LOCAL_SERVER_IDLE_TTL_MS,
  OpenCodeRuntime,
  type OpenCodeRuntimeShape,
} from "../../provider/opencodeRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";

export const NATIVE_STARTUP_BOUNDARY = "native-startup-probe-before-prompt-write";
export const NATIVE_STARTUP_INSTANCE = ProviderInstanceId.makeUnsafe("opencode_native_probe");

export function assertNativeServerCommand(command: ChildProcess.Command, binary: string): void {
  assert.equal(command._tag, "StandardCommand", "Expected one native server launch command");
  if (command._tag !== "StandardCommand") return;
  const serveIndex = command.args.lastIndexOf("serve");
  assert.ok(serveIndex >= 0, "Expected the owned native serve operation");
  const args = command.args.slice(serveIndex);
  assert.equal(args.length, 5);
  assert.equal(args[1], "--hostname");
  assert.equal(args[2], "127.0.0.1");
  assert.equal(args[3], "--port");
  assert.ok(/^\d+$/u.test(args[4]!) && Number(args[4]) > 0 && Number(args[4]) < 65_536);
  // Match the unchanged production planner, including its POSIX priority
  // launcher. That shell execs the pinned binary and retains the owned PID.
  const matchesPlan = [false, true].some((lowerPriority) => {
    const expected = makeEffectProcessCommand(binary, args, {
      ...command.options,
      lowerPriority,
    });
    return (
      expected._tag === "StandardCommand" &&
      expected.command === command.command &&
      expected.args.length === command.args.length &&
      expected.args.every((arg, index) => arg === command.args[index])
    );
  });
  assert.ok(matchesPlan, "Native launch must match the pinned binary's production command plan");
}

export function makeNativeStartupProbe(name: string) {
  assert.equal(process.env.SYNARA_NATIVE_STARTUP_PROBE, "1");
  const binary = process.env.OPENCODE_LIVE_BINARY;
  const evidence = process.env.NATIVE_STARTUP_EVIDENCE;
  assert.ok(binary && evidence);
  assert.equal(resolve(binary), binary);
  mkdirSync(evidence, { recursive: true });
  const origin = performance.now();
  let nextSpan = 0;
  let scenario = name;
  const observations: Array<Record<string, unknown>> = [];
  const record = (kind: string, fields: Record<string, unknown> = {}) => {
    const entry = { kind, scenario, elapsedMs: performance.now() - origin, ...fields };
    observations.push(entry);
    appendFileSync(join(evidence, name + ".ndjson"), JSON.stringify(entry) + "\n");
  };
  const trace = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const id = ++nextSpan;
      const started = performance.now();
      record("phase-start", { id, phase });
      return effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            record("phase-end", {
              id,
              phase,
              durationMs: performance.now() - started,
              exit: exit._tag,
            });
          }),
        ),
      );
    });
  const children: Array<{
    handle: ChildProcessSpawner.ChildProcessHandle;
    pid: number;
    rawExit: "pending" | "success" | "failure";
    code: number | null;
  }> = [];
  const signals: Array<{
    rootPid: number;
    signal: string;
    includeRootTree: boolean;
    captureComplete: boolean;
    descendantCount: number;
  }> = [];
  let productionScopeSucceeded = false;
  const observedSpawner = Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // This dependency outlives the runtime pool that uses it. It never reads
      // stdout/stderr, which remain exclusively owned by the production runtime.
      const observationScope = yield* Scope.Scope;
      const originalSignal = defaultProcessTreeKiller.signal;
      // The observer dependency outlives the runtime pool. Restore it only after
      // real production scope cleanup, including failed startup/teardown.
      yield* Effect.acquireRelease(
        Effect.sync(() => vi.spyOn(defaultProcessTreeKiller, "signal").mockImplementation((input) => {
          // Delegate every real signal once, including when diagnostic I/O fails.
          // No capture, identity, native signal or teardown outcome is replaced.
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
        })),
        (observer) => Effect.sync(() => observer.mockRestore()),
      );
      return ChildProcessSpawner.make((command) =>
        Effect.sync(() => assertNativeServerCommand(command, binary)).pipe(
          Effect.andThen(spawner.spawn(command)),
          Effect.tap((handle) =>
            Effect.gen(function* () {
              const child = {
                handle,
                pid: Number(handle.pid),
                rawExit: "pending" as "pending" | "success" | "failure",
                code: null as number | null,
              };
              children.push(child);
              record("native-spawn", { pid: child.pid });
              yield* handle.exitCode.pipe(
                Effect.exit,
                Effect.flatMap((exit) =>
                  Effect.sync(() => {
                    child.rawExit = Exit.isSuccess(exit) ? "success" : "failure";
                    child.code = Exit.isSuccess(exit) ? Number(exit.value) : null;
                    record("native-root-exit", {
                      pid: child.pid,
                      watcher: child.rawExit,
                      actualCode: child.code,
                    });
                  }),
                ),
                Effect.forkIn(observationScope),
              );
            }),
          ),
        ),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));

  let readinessBarrier: Deferred.Deferred<void> | undefined;
  // Keep default production preparation, capture and teardown on both sources.
  // An injected teardown would deliberately disable #1848 preparation.
  const nativeRuntime = makeOpenCodeRuntimeLive({
    fetchImpl: async (url, init) => {
      const response = await fetch(url, init);
      if (readinessBarrier !== undefined) {
        const entered = readinessBarrier;
        readinessBarrier = undefined;
        assert.ok(response.ok, "The cancellation control first needs a real readiness response");
        assert.ok(init?.signal);
        record("controlled-readiness-hold-entered", { status: response.status });
        await Effect.runPromise(Deferred.succeed(entered, undefined));
        try {
          await new Promise<never>((_, reject) => {
            const signal = init.signal!;
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        } finally {
          // The caller may already have aborted this exact response stream.
          // Only its expected AbortError is benign; keep every other failure
          // visible to the diagnostic instead of treating cleanup as proven.
          try {
            await response.body?.cancel();
          } catch (error) {
            if (
              !init.signal?.aborted ||
              !(error instanceof Error && error.name === "AbortError")
            ) {
              record("controlled-readiness-body-cancel-failed", {
                error: error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
            record("controlled-readiness-body-already-aborted");
          }
          record("controlled-readiness-hold-ended");
        }
      }
      return response;
    },
  }).pipe(Layer.provide(observedSpawner));
  const instrumentedRuntime = Layer.effect(
    OpenCodeRuntime,
    Effect.gen(function* () {
      const runtime = yield* OpenCodeRuntime;
      return {
        ...runtime,
        connectToOpenCodeServer: (input) =>
          trace("runtime.connect-and-readiness", runtime.connectToOpenCodeServer(input)),
      } satisfies OpenCodeRuntimeShape;
    }),
  ).pipe(Layer.provide(nativeRuntime));
  const adapterLayer = Layer.unwrap(
    Effect.map(Effect.service(OpenCodeRuntime), (runtime) => makeOpenCodeAdapterLive({ runtime })),
  ).pipe(Layer.provide(instrumentedRuntime));
  let promptBoundaries = 0;
  let adapterStarts = 0;
  const registryLayer = Layer.effect(
    ProviderAdapterRegistry,
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const observed = {
        ...adapter,
        startSession: (input: Parameters<typeof adapter.startSession>[0]) =>
          trace("adapter.session-start", adapter.startSession(input)).pipe(
            Effect.tap((session) =>
              Effect.sync(() => {
                adapterStarts += 1;
                record("native-session-admitted", {
                  threadId: input.threadId,
                  hasResumeCursor: session.resumeCursor !== undefined,
                });
              }),
            ),
          ),
        stopSession: (threadId: Parameters<typeof adapter.stopSession>[0]) =>
          trace("adapter.session-stop", adapter.stopSession(threadId)),
        sendTurn: (input: Parameters<typeof adapter.sendTurn>[0]) =>
          Effect.suspend(() => {
            promptBoundaries += 1;
            record("before-native-prompt-write", { threadId: input.threadId });
            // The real provider/session/checkpoint prelude has finished. Stop
            // before any prompt write; this is a visible typed diagnostic error.
            return Effect.fail(
              new ProviderAdapterValidationError({
                provider: "opencode",
                operation: "sendTurn",
                issue: NATIVE_STARTUP_BOUNDARY,
              }),
            );
          }),
      };
      return {
        getByProvider: (provider) =>
          provider === "opencode"
            ? Effect.succeed(observed)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        getByInstance: (instanceId) =>
          instanceId === NATIVE_STARTUP_INSTANCE
            ? Effect.succeed(observed)
            : Effect.fail(new ProviderUnsupportedError({ provider: instanceId })),
        listProviders: () => Effect.succeed(["opencode"] as const),
        listInstances: () => Effect.succeed([NATIVE_STARTUP_INSTANCE]),
      } satisfies typeof ProviderAdapterRegistry.Service;
    }),
  ).pipe(Layer.provide(adapterLayer));
  const secrets = new Map<string, Uint8Array>();
  const secretLayer = Layer.succeed(ServerSecretStore, {
    get: (key) => Effect.sync(() => secrets.get(key) ?? null),
    set: (key, value) =>
      Effect.sync(() => {
        secrets.set(key, value);
      }),
    getOrCreateRandom: (key, bytes) =>
      Effect.sync(() => {
        const value = secrets.get(key) ?? randomBytes(bytes);
        secrets.set(key, value);
        return value;
      }),
    remove: (key) =>
      Effect.sync(() => {
        secrets.delete(key);
      }),
  });
  const durableProviderLayer = Layer.unwrap(
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      return makeDurableProviderServiceLive({
        providerIsEnabled: (provider) =>
          settings.getSettings.pipe(
            Effect.map(
              (current) =>
                provider === "opencode" &&
                current.providerInstances[NATIVE_STARTUP_INSTANCE]?.enabled !== false,
            ),
            Effect.orDie,
          ),
      }).pipe(
        Layer.provide(registryLayer),
        Layer.provide(
          ProviderSessionDirectoryLive.pipe(Layer.provide(ProviderSessionRuntimeRepositoryLive)),
        ),
        Layer.provide(secretLayer),
      );
    }),
  );
  const providerLayer = Layer.effect(
    ProviderService,
    Effect.gen(function* () {
      const service = yield* ProviderService;
      assert.ok(service.startSessionWithOutcome);
      const startWithOutcome = service.startSessionWithOutcome;
      return {
        ...service,
        startSession: (...args: Parameters<typeof service.startSession>) =>
          trace("provider.session-start", service.startSession(...args)),
        startSessionWithOutcome: (...args: Parameters<typeof startWithOutcome>) =>
          trace("provider.session-start-with-outcome", startWithOutcome(...args)),
      };
    }),
  ).pipe(Layer.provide(durableProviderLayer));
  const checkpointLayer = Layer.effect(
    CheckpointStore,
    Effect.gen(function* () {
      const store = yield* CheckpointStore;
      return {
        ...store,
        isGitRepository: (cwd: string) =>
          trace("checkpoint.git-discovery", store.isGitRepository(cwd)),
        captureCheckpoint: (...args: Parameters<typeof store.captureCheckpoint>) =>
          trace("checkpoint.capture", store.captureCheckpoint(...args)),
      };
    }),
  ).pipe(Layer.provide(CheckpointStoreLive));
  const gitLayer = Layer.effect(
    GitCore,
    Effect.gen(function* () {
      const git = yield* GitCore;
      return {
        ...git,
        execute: (...args: Parameters<typeof git.execute>) =>
          trace("git." + args[0].operation, git.execute(...args)),
      };
    }),
  ).pipe(Layer.provide(GitCoreLive));
  const coordinatorLayer = Layer.effect(
    TurnCheckpointCoordinator,
    Effect.gen(function* () {
      const coordinator = yield* TurnCheckpointCoordinator;
      return {
        ...coordinator,
        withThreadLease: (threadId, effect) =>
          trace(
            "lease.thread.wait-and-hold",
            coordinator.withThreadLease(threadId, trace("lease.thread.held", effect)),
          ),
        withWorkspaceLease: (cwd, effect) =>
          trace(
            "lease.workspace.wait-and-hold",
            coordinator.withWorkspaceLease(cwd, trace("lease.workspace.held", effect)),
          ),
        withWorkspaceActivationLease: (cwd, effect) =>
          trace(
            "lease.workspace-activation.wait-and-hold",
            coordinator.withWorkspaceActivationLease(
              cwd,
              trace("lease.workspace-activation.held", effect),
            ),
          ),
      } satisfies typeof TurnCheckpointCoordinator.Service;
    }),
  ).pipe(Layer.provide(TurnCheckpointCoordinatorLive));

  record("qualification", {
    binary,
    nativeModel: "opencode/mimo-v2.6-flash-free",
    promptWrites: "Refused before the adapter prompt boundary; no inference call is made",
    sqlite: "Real in-memory SQLite with the production durable provider journal",
    managedPoolIdleTtlMs: OPENCODE_LOCAL_SERVER_IDLE_TTL_MS,
    poolTtlObservation: "Constant recorded separately; no five-minute wait is inferred",
    gateway: "No gateway credential service; production non-gateway pooled-server path",
    teardownOverride: false,
    preparationOverride: false,
    fixtureServices: ["Hub output", "project context", "text generation", "secret store"],
  });
  return {
    binary,
    providerLayer,
    checkpointLayer,
    gitLayer,
    coordinatorLayer,
    observations,
    record,
    trace,
    setScenario: (value: string) => {
      scenario = value;
    },
    promptBoundaries: () => promptBoundaries,
    adapterStarts: () => adapterStarts,
    armReadinessCancellation: () => {
      assert.equal(readinessBarrier, undefined);
      readinessBarrier = Deferred.makeUnsafe<void>();
      return readinessBarrier;
    },
    observeChildren: () =>
      Effect.forEach(children, (child) =>
        child.handle.isRunning.pipe(
          Effect.map((running) => ({
            pid: child.pid,
            running,
            rawExit: child.rawExit,
            code: child.code,
          })),
        ),
      ),
    finishOwnedScope: async (close: () => Promise<void>) => {
      const started = performance.now();
      record("production-scope-close-requested");
      try {
        await close();
        productionScopeSucceeded = true;
        record("production-scope-close-completed", {
          exit: "Success", durationMs: performance.now() - started,
        });
      } catch (error) {
        record("production-scope-close-completed", {
          exit: "Failure", durationMs: performance.now() - started,
          errorClass: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      }
    },
    assertOwnedExit: () => {
      record("owned-exit-summary", {
        children: children.map(({ pid, rawExit, code }) => ({ pid, rawExit, code })),
        signals, productionScopeSucceeded,
        boundary: "Actual default production scope success and raw root exits plus complete real first pre-signal captures. Native teardown is never replaced; scope timing also includes harness/provider cleanup.",
      });
      assert.ok(productionScopeSucceeded, "The real production scope must close successfully");
      assert.ok(children.length > 0, "A native managed process must actually spawn");
      assert.ok(
        children.every((child) => child.rawExit === "success"),
        "Every raw exit watcher must observe an actual terminal code",
      );
      assert.ok(
        children.every((child) => {
          const first = signals.find((signal) => signal.rootPid === child.pid);
          return first?.captureComplete === true && first.includeRootTree === true;
        }),
        "Default production cleanup must start with a complete real owned-tree capture",
      );
    },
  };
}

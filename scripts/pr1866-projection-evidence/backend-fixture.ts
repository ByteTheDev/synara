import fs from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, MessageId, ProjectId, ThreadId } from "@synara/contracts";
import * as processRuntime from "@synara/shared/processRuntime";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";

import { makeOrchestrationIntegrationHarness } from "./OrchestrationEngineHarness.integration.ts";

it(
  "exports actual lifecycle projections while the native fixture turn remains owned",
  async () => {
    const side = process.env.SYNARA_RECONCILIATION_SIDE;
    const source = process.env.SYNARA_RECONCILIATION_SOURCE;
    const output = process.env.SYNARA_RECONCILIATION_OUTPUT;
    const runnerTemp = process.env.RUNNER_TEMP;
    expect(["before", "after"]).toContain(side);
    expect(source).toMatch(/^[0-9a-f]{40}$/);
    if (!output || !runnerTemp || !path.isAbsolute(output)) {
      throw new Error("An explicit owned observation directory is required");
    }
    const relativeOutput = path.relative(runnerTemp, output);
    expect(relativeOutput).not.toBe("");
    expect(path.isAbsolute(relativeOutput)).toBe(false);
    expect(relativeOutput.split(path.sep)).not.toContain("..");
    expect(fs.readdirSync(output)).toEqual([]);
    let reconciliationOffsetMs = 0;
    try {
      const spawnProcess = processRuntime.spawnProcess;
      vi.spyOn(processRuntime, "spawnProcess").mockImplementation((command, args, options) => {
        if (args?.includes("app-server") || args?.includes("--version")) {
          expect(command).toBe(process.execPath);
          expect(options?.env?.CODEX_HOME).toBe(process.env.CODEX_HOME);
          expect(options?.env?.CODEX_SQLITE_HOME).toBe(process.env.CODEX_HOME);
        }
        return spawnProcess(command, args, options);
      });
      await Effect.acquireUseRelease(
        makeOrchestrationIntegrationHarness({
          realCodex: true,
          serverSettings: { providers: { codex: { binaryPath: process.execPath } } },
          runtimeReconcilerOptions: { now: () => Date.now() + reconciliationOffsetMs },
        }),
        (harness) =>
          Effect.gen(function* () {
            // Use the real adapter/process transport against a deterministic local
            // protocol peer. Synara, Codex home/config/SQLite, and Git are isolated.
            const codexState = path.join(harness.rootDir, "codex-home-overlay");
            expect(path.isAbsolute(codexState)).toBe(true);
            expect([
              process.env.USERPROFILE,
              process.cwd(),
              harness.workspaceDir,
              harness.rootDir,
            ]).not.toContain(codexState);
            fs.mkdirSync(codexState);
            fs.writeFileSync(
              path.join(codexState, "config.toml"),
              `sqlite_home = ${JSON.stringify(codexState)}\n`,
            );
            vi.stubEnv("SYNARA_HOME", harness.rootDir);
            vi.stubEnv("CODEX_HOME", codexState);
            vi.stubEnv("CODEX_SQLITE_HOME", codexState);
            fs.copyFileSync(
              path.join(import.meta.dirname, "fixtures/codexLifecycle.cjs"),
              path.join(harness.workspaceDir, "app-server"),
            );

            const projectId = ProjectId.makeUnsafe("lifecycle-project");
            const threadId = ThreadId.makeUnsafe("lifecycle-thread");
            const modelSelection = { provider: "codex", model: "gpt-5.6-sol" } as const;
            const createdAt = new Date().toISOString();
            yield* harness.engine.dispatch({
              type: "project.create",
              commandId: CommandId.makeUnsafe("lifecycle-project-create"),
              projectId,
              title: "Lifecycle fixture",
              workspaceRoot: harness.workspaceDir,
              defaultModelSelection: modelSelection,
              createdAt,
            });
            yield* harness.engine.dispatch({
              type: "thread.create",
              commandId: CommandId.makeUnsafe("lifecycle-thread-create"),
              threadId,
              projectId,
              title: "Lifecycle fixture",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
            });
            const start = (id: string, dispatchOrigin: "user" | "automation") =>
              harness.engine.dispatch({
                type: "thread.turn.start",
                commandId: CommandId.makeUnsafe(`${id}-start`),
                threadId,
                message: {
                  messageId: MessageId.makeUnsafe(id),
                  role: "user",
                  text: id,
                  attachments: [],
                },
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                dispatchMode: "queue",
                dispatchOrigin,
                createdAt: new Date().toISOString(),
              });
            yield* start("manual-message", "user");
            // Model refresh stderr can arrive before a provider turn ID exists.
            // It must remain visible without failing or retrying the first start.
            yield* harness.waitForDomainEvent(
              (event) =>
                event.type === "thread.activity-appended" &&
                event.payload.activity.kind === "runtime.warning" &&
                JSON.stringify(event.payload.activity.payload).includes(
                  "failed to refresh available models: timeout waiting for child process to exit",
                ),
            );
            const manual = yield* harness.waitForThread(
              threadId,
              (thread) =>
                thread.latestTurn?.state === "running" &&
                thread.session?.activeTurnId === "fixture-turn-1" &&
                thread.messages.some((message) =>
                  message.text.includes("Working on fixture-turn-1"),
                ),
            );
            expect(manual.session?.lastError).toBeNull();

            const liveSnapshot = yield* harness.snapshotQuery.getSnapshot();
            const liveSessions = yield* harness.providerService.listSessions();
            const liveOwner = liveSessions.find((session) => session.threadId === threadId);
            expect(liveOwner?.activeTurnId).toBe("fixture-turn-1");
            const observedLiveAt = new Date().toISOString();

            // Advance only reconciliation's observation clock. The live adapter
            // and its activity watchdog continue using real time.
            const reconcileAfterDeadline = () =>
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  reconciliationOffsetMs = 46 * 60_000;
                }),
                () => harness.runtimeReconciler.reconcileNow,
                () =>
                  Effect.sync(() => {
                    reconciliationOffsetMs = 0;
                  }),
              );
            yield* reconcileAfterDeadline();

            const expectedProjectionStatus = side === "before" ? "interrupted" : "running";
            yield* harness.waitForThread(
              threadId,
              (thread) =>
                thread.session?.status === expectedProjectionStatus &&
                thread.latestTurn?.state === expectedProjectionStatus,
            );
            const reconciledSnapshot = yield* harness.snapshotQuery.getSnapshot();
            const sessionsAfterReconciliation = yield* harness.providerService.listSessions();
            const stillOwned = sessionsAfterReconciliation.find(
              (session) => session.threadId === threadId,
            );
            // This is the actual discrepancy: the adapter still owns turn 1.
            // Neither fixture nor presentation fabricates that native ownership.
            expect(stillOwned?.activeTurnId).toBe("fixture-turn-1");
            const projected = reconciledSnapshot.threads.find((thread) => thread.id === threadId);
            expect(projected?.session?.activeTurnId).toBe(
              side === "before" ? null : "fixture-turn-1",
            );
            expect(projected?.latestTurn?.completedAt === null).toBe(side === "after");
            expect(liveSnapshot.threads).toHaveLength(1);
            expect(reconciledSnapshot.threads).toHaveLength(1);
            const protocol = fs.readFileSync(path.join(codexState, "protocol.jsonl"), "utf8")
              .trim().split("\n").map((line) => JSON.parse(line));
            expect(protocol).toEqual([{ type: "started", turnId: "fixture-turn-1" }]);
            fs.writeFileSync(path.join(output, "projection.json"), JSON.stringify({
              schemaVersion: 1,
              side,
              source,
              driver: process.env.GITHUB_SHA,
              threadId,
              reconciliationObservationOffsetMs: 46 * 60_000,
              realAdapterAndWatchdogClock: true,
              actualNativeTurnIdBefore: liveOwner?.activeTurnId,
              actualNativeTurnIdAfter: stillOwned?.activeTurnId,
              protocol,
              capturedAt: new Date().toISOString(),
              observations: [
                { stage: "live", capturedAt: observedLiveAt, snapshot: liveSnapshot },
                { stage: "reconciled", capturedAt: new Date().toISOString(),
                  snapshot: reconciledSnapshot },
              ],
              qualification:
                "Actual SQLite getSnapshot results from the production Codex adapter, orchestration and reconciler using the unchanged isolated Node protocol peer. Only reconciliation's observation clock is advanced; this is not 46 minutes of elapsed native execution, model inference, or a hand-authored UI state.",
            }, null, 2) + "\n", { flag: "wx" });
            // Release occurs through the same owned harness disposal below.
            // The two original end-to-end protocol assertions run separately,
            // unchanged, including both manual/automation completion choices.
          }),
        (harness) => harness.dispose,
      ).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.runPromise);
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  },
);

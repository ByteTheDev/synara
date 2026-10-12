import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { CheckpointRef } from "@synara/contracts";

import { ServerConfig } from "./config.ts";
import { GitCoreLive } from "./git/Layers/GitCore.ts";
import { GitCore, type GitCoreShape } from "./git/Services/GitCore.ts";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "./checkpointing/Services/CheckpointStore.ts";
import { parseCheckpointFilesFromUnifiedDiff } from "./checkpointing/Diffs.ts";

type Observed<T> = { ok: true; value: T } | { ok: false; error: string };
const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const source = JSON.parse(process.env.PR1863_SOURCE_PIN ?? "null");
assert(source && /^[0-9a-f]{40}$/.test(source.sha) && /^[0-9a-f]{40}$/.test(source.tree));
assert(process.env.PR1863_PROBE_OUTPUT && process.env.RUNNER_TEMP);
const output = path.resolve(process.env.PR1863_PROBE_OUTPUT);
assert(!existsSync(output), "Refuse replacing a prior probe result");
const root = mkdtempSync(path.join(process.env.RUNNER_TEMP, "pr1863-native-probe-"));
const variants = [
  { name: "default", config: {} },
  { name: "noprefix", config: { "diff.noprefix": "true" } },
  { name: "mnemonic", config: { "diff.mnemonicPrefix": "true" } },
  { name: "custom", config: { "diff.srcPrefix": "old", "diff.dstPrefix": "new" } },
  { name: "color", config: { "color.diff": "always" } },
];
const initial = {
  "README.md": "# Prefix example\n\nThe greeting uses the original text.\n",
  "src/greeting.ts": 'export const greeting = "Hello";\n',
};
const changed = {
  "README.md": "# Prefix example\n\nThe greeting now includes the workspace name.\n",
  "src/greeting.ts": 'export const greeting = "Hello, Synara";\n',
};
const expectedPaths = Object.keys(initial).sort();
const scenarios: Record<string, unknown>[] = [];
const failures: Record<string, unknown>[] = [];
const cleanup: Record<string, unknown>[] = [];
let ui: Record<string, unknown> | null = null;

const writeFiles = (cwd: string, files: Record<string, string>) => {
  for (const [relative, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(cwd, relative)), { recursive: true });
    writeFileSync(path.join(cwd, relative), text);
  }
};
const readFiles = (cwd: string) =>
  Object.fromEntries(expectedPaths.map((relative) => [relative, readFileSync(path.join(cwd, relative), "utf8")]));
const sameFiles = (actual: unknown, expected: unknown) => JSON.stringify(actual) === JSON.stringify(expected);
const rawHeader = (patch: string, relative: string) =>
  patch.includes("diff --git a/" + relative + " b/" + relative) && !patch.includes("\u001b[");

try {
  for (const variant of variants) {
    const owned = path.join(root, variant.name);
    const repo = path.join(owned, "repo");
    const checkpointRepo = path.join(owned, "checkpoint");
    mkdirSync(repo, { recursive: true });
    mkdirSync(checkpointRepo);
    const operations: Record<string, unknown>[] = [];
    const gitLayer = GitCoreLive.pipe(
      Layer.provide(ServerConfig.layerTest(repo, path.join(owned, "profile"))),
      Layer.provide(NodeServices.layer),
    );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        gitLayer,
        CheckpointStoreLive.pipe(Layer.provide(gitLayer), Layer.provide(NodeServices.layer)),
      ),
    );
    const evaluate = async <T>(label: string, effect: Effect.Effect<T, unknown, GitCore | CheckpointStore>): Promise<Observed<T>> => {
      const startedAt = new Date().toISOString();
      const exit = await runtime.runPromise(Effect.exit(effect));
      const result: Observed<T> = Exit.isSuccess(exit)
        ? { ok: true, value: exit.value }
        : { ok: false, error: Cause.pretty(exit.cause) };
      operations.push({ label, startedAt, completedAt: new Date().toISOString(), ...result });
      return result;
    };
    const git = async (cwd: string, args: string[]) => {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const core = yield* GitCore;
          return yield* core.execute({ cwd, args, operation: "PR1863.nativeFixture", timeoutMs: 15_000 });
        }),
      );
      operations.push({ label: "fixture-git", cwd, args, code: result.code, stdout: result.stdout, stderr: result.stderr });
      return result.stdout.trim();
    };
    const configure = async (cwd: string) => {
      await git(cwd, ["init", "--initial-branch=main"]);
      for (const [key, value] of Object.entries({
        "user.name": "PR 1863 native fixture",
        "user.email": "pr1863@example.invalid",
        "core.autocrlf": "false",
        "diff.noprefix": "false",
        "diff.mnemonicPrefix": "false",
        "diff.srcPrefix": "a/",
        "diff.dstPrefix": "b/",
        "color.diff": "never",
        ...variant.config,
      })) await git(cwd, ["config", "--local", key, value]);
    };
    const checks: Record<string, boolean> = {};
    try {
      await configure(repo);
      writeFiles(repo, initial);
      writeFileSync(path.join(repo, "binary.dat"), Buffer.from([0, 1, 2, 3]));
      await git(repo, ["add", "."]);
      await git(repo, ["commit", "-m", "initial fixture"]);
      await git(repo, ["checkout", "-b", "feature/prefix"]);
      writeFileSync(path.join(repo, "branch.txt"), "committed branch change\n");
      await git(repo, ["add", "branch.txt"]);
      await git(repo, ["commit", "-m", "branch fixture"]);
      writeFileSync(path.join(repo, "staged.txt"), "staged change\n");
      await git(repo, ["add", "staged.txt"]);
      writeFiles(repo, changed);
      writeFileSync(path.join(repo, "binary.dat"), Buffer.from([0, 5, 6, 7, 8]));
      const readers = [
        ["unstaged", (core: GitCoreShape) => core.readUnstagedPatch(repo), "README.md"],
        ["staged", (core: GitCoreShape) => core.readStagedPatch(repo), "staged.txt"],
        ["workingTree", (core: GitCoreShape) => core.readWorkingTreePatch(repo), "README.md"],
        ["branch", (core: GitCoreShape) => core.readBranchPatch(repo), "branch.txt"],
        ["ref", (core: GitCoreShape) => core.readRefPatch(repo, "main"), "README.md"],
      ] as const;
      for (const [name, read, relative] of readers) {
        const observed = await evaluate(name, Effect.gen(function* () {
          const core = yield* GitCore;
          return yield* read(core);
        }));
        checks[name] = observed.ok && rawHeader(observed.value.patch, relative);
      }
      const worktree = path.join(owned, "copy");
      const copied = await evaluate("copyCheckoutChanges", Effect.gen(function* () {
        const core = yield* GitCore;
        yield* core.createDetachedWorktree({ cwd: repo, ref: "HEAD", path: worktree, copyChangesFrom: repo });
        return {
          text: readFiles(worktree),
          binarySha256: sha256(readFileSync(path.join(worktree, "binary.dat"))),
          staged: readFileSync(path.join(worktree, "staged.txt"), "utf8"),
        };
      }));
      checks.copy = copied.ok && sameFiles(copied.value.text, changed) &&
        copied.value.binarySha256 === sha256(Buffer.from([0, 5, 6, 7, 8])) &&
        copied.value.staged === "staged change\n";
      const snapshotPath = path.join(owned, "snapshot");
      const snapshot = await evaluate("snapshotWorktree", Effect.gen(function* () {
        const core = yield* GitCore;
        yield* core.snapshotWorktree({ cwd: repo, outputPath: snapshotPath });
        return readFileSync(path.join(snapshotPath, "changes.patch"), "utf8");
      }));
      checks.snapshot = snapshot.ok && rawHeader(snapshot.value, "README.md") &&
        snapshot.value.includes("GIT binary patch");

      await configure(checkpointRepo);
      writeFiles(checkpointRepo, initial);
      await git(checkpointRepo, ["add", "."]);
      await git(checkpointRepo, ["commit", "-m", "initial checkpoint fixture"]);
      const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/pr1863/turn/start");
      const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/pr1863/turn/end");
      const checkpoint = await evaluate("checkpointDiff", Effect.gen(function* () {
        const store = yield* CheckpointStore;
        yield* store.captureCheckpoint({ cwd: checkpointRepo, checkpointRef: fromRef });
        writeFiles(checkpointRepo, changed);
        yield* store.captureCheckpoint({ cwd: checkpointRepo, checkpointRef: toRef });
        const diff = yield* store.diffCheckpoints({
          cwd: checkpointRepo, fromCheckpointRef: fromRef, toCheckpointRef: toRef,
          ignoreWhitespace: false,
        });
        return { diff };
      }));
      checks.checkpointHeaders = checkpoint.ok &&
        expectedPaths.every((relative) => rawHeader(checkpoint.value.diff, relative));
      const summary = checkpoint.ok
        ? await evaluate("checkpointSummary", parseCheckpointFilesFromUnifiedDiff(checkpoint.value.diff))
        : { ok: false as const, error: "No checkpoint diff was produced" };
      checks.summaryPaths = summary.ok &&
        sameFiles(summary.value.map((file) => file.path).sort(), expectedPaths);
      const undone = await evaluate("reverseCheckpointDiff", Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const applied = yield* store.reverseCheckpointDiff({
          cwd: checkpointRepo, fromCheckpointRef: fromRef, toCheckpointRef: toRef,
        });
        return { applied, files: readFiles(checkpointRepo) };
      }));
      checks.undo = undone.ok && undone.value.applied === true && sameFiles(undone.value.files, initial);
      if (variant.name === "noprefix") {
        ui = {
          schemaVersion: 1, source, config: { ...variant.config, "core.autocrlf": "false" },
          expectedPaths, checkpoint, summary,
          label: "Actual CheckpointStore/GitCore output from an owned native Git fixture; UI transport may replay these exact bytes.",
        };
      }
      if (existsSync(path.join(worktree, ".git"))) {
        const removed = await evaluate("removeOwnedWorktree", Effect.gen(function* () {
          const core = yield* GitCore;
          yield* core.removeWorktree({ cwd: repo, path: worktree, force: true });
          return !existsSync(worktree);
        }));
        checks.worktreeRemoved = removed.ok && removed.value;
      } else {
        checks.worktreeRemoved = !existsSync(worktree);
      }
      for (const [check, passed] of Object.entries(checks)) {
        if (!passed) failures.push({ scenario: variant.name, check });
      }
    } catch (error) {
      failures.push({ scenario: variant.name, stage: "fixture-or-observation", error: String(error) });
    } finally {
      try { await runtime.dispose(); cleanup.push({ scenario: variant.name, runtimeDisposed: true }); }
      catch (error) { failures.push({ scenario: variant.name, stage: "runtime-dispose", error: String(error) }); }
      try { rmSync(owned, { recursive: true }); cleanup.push({ scenario: variant.name, ownedTreeRemoved: !existsSync(owned) }); }
      catch (error) { failures.push({ scenario: variant.name, stage: "owned-tree-remove", error: String(error) }); }
      scenarios.push({ name: variant.name, config: variant.config, checks, operations });
    }
  }
} finally {
  try { rmSync(root, { recursive: true }); cleanup.push({ rootRemoved: !existsSync(root) }); }
  catch (error) { failures.push({ stage: "root-remove", error: String(error) }); }
  const report = {
    schemaVersion: 1, source, platform: process.platform, architecture: process.arch,
    executable: process.execPath, node: process.version, scenarios, failures, cleanup, ui,
    qualification: "Real source GitCore/CheckpointStore and Git operations, with repo-local LF fixture bytes and explicit diff settings. This does not execute a live provider or GitHub API, change user Git configuration, prove arbitrary descendant cleanup, or replace the separately retained canonical tests.",
  };
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log("PR1863_NATIVE_PROBE " + JSON.stringify({ source: source.sha, scenarios: scenarios.length, failures, cleanup }));
  process.exitCode = failures.length ? 1 : 0;
}

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observeCommand } from "./owned-command-observer.mjs";
import { boundedStableRead, freezeDirectory, freezeFile } from "./snapshots.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const driverRoot = path.resolve(directory, "../..");
const pins = JSON.parse(readFileSync(path.join(directory, "pins.json"), "utf8"));
const driverRelative = ".pr1862-driver";
const browserLiveRelative = "pr1862-browser-live";
const formatLiveRelative = "pr1862-format-live";
const configRelative = "apps/web/vitest.timeline-height-evidence.config.ts";
const driverPaths = [
  ".github/workflows/timeline-height-1862-validation.yml",
  "scripts/timeline-height-1862-validation/README.md",
  "scripts/timeline-height-1862-validation/pins.json",
  "scripts/timeline-height-1862-validation/runner.mjs",
  "scripts/timeline-height-1862-validation/snapshots.mjs",
  "scripts/timeline-height-1862-validation/owned-command-observer.mjs",
  "scripts/timeline-height-1862-validation/vitest.timeline-height-evidence.config.ts",
];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) => createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
const now = () => new Date().toISOString();
const errorRecord = (error) => ({ name: error.name, message: error.message, code: error.code ?? null });
const meta = (relative, bytes) => ({ path: relative, bytes: bytes.length, sha256: digest(bytes), gitBlob: blob(bytes) });
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], {
  timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024,
});
const safe = (relative) => {
  assert(relative && !path.isAbsolute(relative) && !relative.includes("\\"));
  assert(relative.split("/").every((part) => part && part !== "." && part !== ".."));
  return relative;
};

function verifyDriver() {
  assert.equal(git(driverRoot, "rev-parse", "HEAD").toString().trim(), process.env.GITHUB_SHA);
  git(driverRoot, "diff", "--exit-code", "HEAD", "--");
  return driverPaths.map((relative) => {
    const bytes = boundedStableRead(path.join(driverRoot, relative), 512 * 1024).bytes;
    assert(bytes.equals(git(driverRoot, "show", "HEAD:" + relative)), relative);
    return meta(relative, bytes);
  });
}
function complete(result, allowed = [0]) {
  assert(result, "Missing actual command result");
  assert.equal(result.actualRootExitObserved, true);
  assert(allowed.includes(result.actualRootExit), "Actual nonzero command remains a failure.");
  assert.equal(result.actualRootSignal, null);
  assert.equal(result.closeObserved, true);
  assert.equal(result.closeCode, result.actualRootExit);
  assert.equal(result.closeSignal, null);
  assert.equal(result.deadline, false);
  assert.equal(result.capped, false);
  assert.equal(result.forcedOutputCutoff, false);
  assert.deepEqual(result.processErrors, []);
  assert.deepEqual(result.outputErrors, []);
  assert.equal(result.observerStatus, result.actualRootExit);
}
function sourceProof(root, pin, created, side, stage) {
  assert.equal(git(root, "rev-parse", "HEAD").toString().trim(), pin.sha);
  assert.equal(git(root, "rev-parse", "HEAD^{tree}").toString().trim(), pin.tree);
  git(root, "diff", "--exit-code", "HEAD", "--");
  const listing = git(root, "ls-tree", "-r", "-z", "HEAD");
  let count = 0;
  for (const entry of listing.toString().split("\0").filter(Boolean)) {
    const match = /^(\d{6}) blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
    assert(match, "Unexpected tracked entry");
    const [, mode, expected, relative] = match;
    safe(relative);
    const full = path.join(root, relative);
    const stat = lstatSync(full);
    let bytes;
    if (mode === "120000") {
      assert(stat.isSymbolicLink());
      bytes = Buffer.from(readlinkSync(full));
    } else {
      assert(["100644", "100755"].includes(mode) && stat.isFile() && !stat.isSymbolicLink());
      assert.equal(Boolean(stat.mode & 0o111), mode === "100755", relative);
      bytes = readFileSync(full);
    }
    assert.equal(blob(bytes), expected, relative);
    count++;
  }
  assert.equal(count, pin.files);
  for (const [relative, record] of created) {
    const bytes = boundedStableRead(path.join(root, relative), 512 * 1024).bytes;
    assert.equal(blob(bytes), record.gitBlob, relative);
    assert.equal(bytes.length, record.bytes, relative);
  }
  const status = git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all")
    .toString().split("\0").filter(Boolean);
  for (const entry of status) {
    assert.equal(entry.slice(0, 2), "??", "Tracked source may not change.");
    const relative = entry.slice(3);
    assert(created.has(relative) || relative === driverRelative + "/" ||
      relative.startsWith(driverRelative + "/") ||
      relative.startsWith(browserLiveRelative + "/" + side + "/") ||
      relative.startsWith(formatLiveRelative + "/"), "Unexpected untracked file: " + relative);
  }
  assert.equal(blob(readFileSync(path.join(root, ".github/actions/setup-workspace/action.yml"))), pins.setupBlob);
  assert.equal(blob(readFileSync(path.join(root, pins.scroll.source))), pins.scroll.blob);
  if (side === "after") {
    for (const feature of pins.features) {
      const bytes = readFileSync(path.join(root, feature.path));
      assert.equal(blob(bytes), feature.sha);
      assert.equal(bytes.length, feature.bytes);
    }
  }
  return { at: now(), stage, head: pin.sha, tree: pin.tree, trackedFiles: count,
    listingSha256: digest(listing), status, created: [...created.values()],
    rawTrackedBytesAndModesVerified: true };
}
function assertionsFor(report, absolutePath, count) {
  const suites = report.testResults.filter((suite) => path.resolve(suite.name) === absolutePath);
  assert.equal(suites.length, 1, "Exactly one expected suite");
  assert.equal(suites[0].assertionResults.length, count, "All cases must be present.");
  assert(suites[0].assertionResults.every((entry) => ["passed", "failed"].includes(entry.status)),
    "No skips, todo or filtered controls.");
  return suites[0].assertionResults;
}
function verifyControl(report, result, root, side, kind) {
  complete(result, side === "before" ? [1] : [0]);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numTodoTests, 0);
  const expectedTotal = kind === "unit" ? pins.unit.cases : pins.hook.cases + pins.scroll.cases;
  assert.equal(report.numTotalTests, expectedTotal);
  const outcomes = [];
  if (kind === "unit") {
    assert.equal(report.testResults.length, 1);
    const rows = assertionsFor(report, path.join(root, pins.unit.target), pins.unit.cases);
    for (const title of pins.unit.originalTitles) {
      const original = rows.filter((entry) => entry.title === title);
      assert.equal(original.length, 1);
      assert.equal(original[0].status, "passed", "The original height assertion must still pass.");
    }
    if (side === "before") assert(rows.some((entry) => entry.status === "failed"));
    else assert(rows.every((entry) => entry.status === "passed"));
    outcomes.push(...rows);
  } else {
    assert.equal(report.testResults.length, 2);
    const hooks = assertionsFor(report, path.join(root, pins.hook.target), pins.hook.cases);
    assert(hooks.every((entry) => entry.status === (side === "before" ? "failed" : "passed")));
    const original = assertionsFor(report, path.join(root, pins.scroll.source), pins.scroll.cases);
    assert(original.every((entry) => entry.status === "passed"), "All original scroll/reveal cases must pass.");
    outcomes.push(...hooks, ...original);
  }
  const failed = outcomes.filter((entry) => entry.status === "failed").length;
  assert.equal(report.numFailedTests, failed);
  assert.equal(report.numPassedTests, expectedTotal - failed);
  assert.equal(report.success, side === "after");
  return { kind, side, total: expectedTotal, passed: report.numPassedTests, failed,
    originalAssertionsRetained: true, actualExit: result.actualRootExit,
    outcomes: outcomes.map(({ title, fullName, status, failureMessages }) => ({ title, fullName, status, failureMessages })),
    qualification: side === "before" ? "Expected counterexamples remain actual failed Vitest commands and a failed job."
      : "All selected original and added assertions passed at the exact source." };
}
function verifyPreservation(report, result, expectedPaths) {
  complete(result);
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert(report.numPassedTests > 0);
  assert.deepEqual(report.testResults.map((suite) => path.resolve(suite.name)).sort(), expectedPaths.toSorted());
  return { passed: report.numPassedTests, failed: report.numFailedTests,
    pending: report.numPendingTests, todo: report.numTodoTests,
    suites: report.testResults.map((suite) => ({ name: suite.name, outcomes: suite.assertionResults })) };
}

async function main() {
  const mode = process.argv[2];
  const side = process.argv[3];
  assert(["controls", "static"].includes(mode) && ["before", "after"].includes(side));
  assert(mode !== "static" || side === "after");
  assert.equal(process.platform, "linux");
  assert(process.env.GITHUB_WORKSPACE && process.env.RUNNER_TEMP && /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA));
  const root = path.resolve(process.env.GITHUB_WORKSPACE);
  assert.equal(path.relative(root, driverRoot), driverRelative);
  const pin = pins[side];
  const output = path.join(process.env.RUNNER_TEMP, "pr1862-" + mode + "-" + side);
  const live = path.join(output, "live");
  const frozen = path.join(output, "frozen");
  const browserOutput = path.join(root, browserLiveRelative, side);
  const formatOutput = path.join(root, formatLiveRelative);
  assert(!existsSync(output) && !existsSync(browserOutput) && !existsSync(formatOutput));
  mkdirSync(live, { recursive: true });
  mkdirSync(frozen);
  mkdirSync(browserOutput, { recursive: true });
  const created = new Map();
  const records = [];
  const phases = [];
  const failures = [];
  const verifications = [];
  const writeJson = (relative, value) => {
    safe(relative);
    const file = path.join(frozen, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  };
  const attempt = async (name, callback) => {
    try { return await callback(); }
    catch (error) { failures.push({ phase: name, ...errorRecord(error) }); return null; }
  };
  const proof = (stage) => sourceProof(root, pin, created, side, stage);
  const capture = (file, relative, cap = 32 * 1024 * 1024) =>
    freezeFile(file, frozen, safe(relative), records, cap);
  const command = async (name, argv, cwd, deadlineMs, allowed = [0], env = {}) => {
    let result = null;
    try {
      result = await observeCommand({
        command: argv, cwd, deadlineMs, drainMs: 10_000,
        capBytes: 32 * 1024 * 1024, logPath: path.join(live, name + ".log"),
        spawnChild: (executable, args, options) => spawn(executable, args, {
          ...options, env: { ...options.env, ...env },
        }),
      });
      writeJson(name + "-process.json", result);
      // A Before test's nonzero result is retained as an actual failure even when
      // its separate counterexample verifier recognizes the intended regression.
      complete(result, allowed);
    } catch (error) { failures.push({ phase: name, ...errorRecord(error) }); }
    finally {
      await attempt(name + "-log-snapshot", () => capture(path.join(live, name + ".log"), name + ".log"));
      phases.push({ name, result });
    }
    return result;
  };
  const phase = async (name, argv, cwd, deadlineMs, env = {}) => {
    writeJson("source-before-" + name + ".json", proof("before-" + name));
    const result = await command(name, argv, cwd, deadlineMs, [0], env);
    await attempt(name + "-source", () => writeJson("source-after-" + name + ".json", proof("after-" + name)));
    return result;
  };
  const addOwned = (relative, bytes) => {
    safe(relative);
    const full = path.join(root, relative);
    assert(!existsSync(full));
    writeFileSync(full, bytes, { flag: "wx" });
    created.set(relative, meta(relative, bytes));
  };
  let driverBefore = null;
  try {
    driverBefore = verifyDriver();
    writeJson("provenance.json", { schemaVersion: 1, mode, side, pin, driverHead: process.env.GITHUB_SHA,
      driver: driverBefore, qualification: pins.qualification });
    writeJson("source-before.json", proof("initial"));
    if (mode === "controls") {
      for (const spec of [pins.unit, pins.hook]) {
        const bytes = git(driverRoot, "show", "HEAD:" + spec.source);
        assert.equal(blob(bytes), spec.blob); assert.equal(bytes.length, spec.bytes);
        addOwned(spec.target, bytes);
      }
      addOwned(configRelative, readFileSync(path.join(directory, "vitest.timeline-height-evidence.config.ts")));
      writeJson("fixture-pins.json", [...created.values()]);
      for (const kind of ["unit", "browser"]) {
        await attempt(kind + "-control", async () => {
          const args = ["bunx", "--no-install", "vitest", "run",
            "--maxWorkers=1", "--no-file-parallelism", "--reporter=verbose", "--reporter=json",
            "--outputFile=" + path.join(live, kind + ".json")];
          if (kind === "unit") args.push(path.relative(path.join(root, "apps/web"), path.join(root, pins.unit.target)));
          else args.push("--config", path.basename(configRelative));
          const result = await phase(kind, args, path.join(root, "apps/web"), 15 * 60_000,
            { PR1862_SCREENSHOTS: browserOutput });
          capture(path.join(live, kind + ".json"), kind + ".json");
          const report = JSON.parse(readFileSync(path.join(frozen, kind + ".json"), "utf8"));
          const verified = verifyControl(report, result, root, side, kind);
          verifications.push(verified); writeJson(kind + "-verification.json", verified);
        });
      }
    } else {
      await attempt("format-check", () => phase("format-check",
        ["bun", "run", "fmt:check", ...pins.features.map((file) => file.path)], root, 3 * 60_000));
      await attempt("format-proposal", async () => {
        writeJson("source-before-format-proposal.json", proof("before-format-proposal"));
        mkdirSync(formatOutput);
        const prepared = [];
        for (const file of pins.features) {
          const original = boundedStableRead(path.join(root, file.path), 512 * 1024).bytes;
          assert.equal(blob(original), file.sha);
          const copy = path.join(formatOutput, file.path);
          mkdirSync(path.dirname(copy), { recursive: true });
          writeFileSync(copy, original, { flag: "wx" });
          prepared.push({ file, copy, original });
        }
        const formatted = await command("format-copies",
          ["bun", "run", "fmt", ...prepared.map((item) => item.copy)], root, 3 * 60_000);
        complete(formatted);
        const proposal = [];
        for (let i = 0; i < prepared.length; i++) {
          const { file, copy, original } = prepared[i];
          const after = boundedStableRead(copy, 512 * 1024);
          const beforePath = path.join(live, "format-before-" + i);
          const afterPath = path.join(live, "format-after-" + i);
          writeFileSync(beforePath, original, { flag: "wx", mode: 0o444 });
          writeFileSync(afterPath, after.bytes, { flag: "wx", mode: 0o444 });
          const difference = await command("format-diff-" + i,
            ["git", "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--",
              beforePath, afterPath], root, 30_000, [0, 1]);
          complete(difference, [0, 1]);
          proposal.push({ path: file.path, before: meta(file.path, original),
            after: { ...meta(file.path, after.bytes), cutoffUtc: after.cutoffUtc },
            actualDiffExit: difference.actualRootExit,
            patch: readFileSync(path.join(frozen, "format-diff-" + i + ".log"), "utf8") });
        }
        writeJson("format-proposal.json", { source: pin.sha, tree: pin.tree, complete: true,
          configuration: digest(readFileSync(path.join(root, ".oxfmtrc.json"))),
          files: proposal, originalFormatFailurePreserved: true });
        console.log("TIMELINE1862_FORMAT_PROPOSAL " + JSON.stringify(proposal));
        writeJson("source-after-format-proposal.json", proof("after-format-proposal"));
      });
      for (const [name, cwd, selected] of [
        ["web-preservation", path.join(root, "apps/web"), pins.unitPreservation],
        ["server-process", path.join(root, "apps/server"), ["src/platform/processTreeController.test.ts"]],
      ]) {
        await attempt(name, async () => {
          const result = await phase(name,
            ["bunx", "--no-install", "vitest", "run", "--maxWorkers=1", "--no-file-parallelism",
              "--reporter=verbose", "--reporter=json", "--outputFile=" + path.join(live, name + ".json"), ...selected],
            cwd, 10 * 60_000);
          capture(path.join(live, name + ".json"), name + ".json");
          const verified = verifyPreservation(JSON.parse(readFileSync(path.join(frozen, name + ".json"), "utf8")),
            result, selected.map((file) => path.join(cwd, file)));
          verifications.push({ name, ...verified }); writeJson(name + "-verification.json", verified);
        });
      }
      for (const workspace of ["web", "server"]) {
        await attempt(workspace + "-types", () => phase(workspace + "-types",
          ["bun", "run", "typecheck"], path.join(root, "apps", workspace), 10 * 60_000));
      }
      await attempt("brand-check", () => phase("brand-check", ["bun", "run", "brand:check"], root, 3 * 60_000));
    }
  } catch (error) { failures.push({ phase: "setup-or-validation", ...errorRecord(error) }); }
  finally {
    await attempt("failure-screenshots", () => {
      const screenshotRecords = [];
      freezeDirectory(browserOutput, path.join(frozen, "browser"), screenshotRecords, 64 * 1024 * 1024);
      records.push(...screenshotRecords.map((record) => ({ ...record, path: "browser/" + record.path })));
    });
    for (const [relative, record] of created) {
      await attempt("remove-owned:" + relative, () => {
        const bytes = boundedStableRead(path.join(root, relative), 512 * 1024).bytes;
        assert.equal(blob(bytes), record.gitBlob, "Refuse removing a changed fixture.");
        unlinkSync(path.join(root, relative));
      });
    }
    created.clear();
    await attempt("restored-source", () => writeJson("source-restored.json", proof("restored")));
    await attempt("final-driver", () => {
      const after = verifyDriver();
      assert.deepEqual(after, driverBefore);
      writeJson("driver-final.json", { head: process.env.GITHUB_SHA, files: after });
    });
    writeJson("snapshot-captures.json", records);
    const exitCode = failures.length ? 1 : 0;
    writeJson("result.json", { mode, side, source: pin, driverHead: process.env.GITHUB_SHA,
      phases, failures, verifications, exitCode, verificationPassed: failures.length === 0,
      descendantExitProven: false, qualification: pins.qualification });
    const files = [];
    // The bounded directory helper admits every retained regular file, including
    // any failed-test screenshots; the manifest itself is written last.
    const manifestRoot = path.join(output, "manifest-snapshot");
    const manifestRecords = [];
    freezeDirectory(frozen, manifestRoot, manifestRecords, 160 * 1024 * 1024);
    for (const record of manifestRecords) {
      const bytes = boundedStableRead(path.join(frozen, record.path), 80 * 1024 * 1024).bytes;
      files.push(meta(record.path, bytes));
    }
    writeJson("manifest.json", { schemaVersion: 1, mode, side, source: pin, driverHead: process.env.GITHUB_SHA, files });
    console.log(JSON.stringify({ mode, side, source: pin.sha, exitCode, failures, verifications }));
    process.exitCode = exitCode;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

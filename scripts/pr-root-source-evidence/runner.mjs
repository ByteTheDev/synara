import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedStableRead, freezeDirectory, freezeFile } from "./snapshots.mjs";

const root = process.cwd();
const scripts = dirname(fileURLToPath(import.meta.url));
const driverRoot = resolve(scripts, "../..");
const targets = JSON.parse(readFileSync(join(scripts, "targets.json"), "utf8"));
const fixtures = JSON.parse(readFileSync(join(scripts, "fixtures.json"), "utf8"));
const target = targets.find((entry) => entry.id === process.env.PR_ROOT_ID);
assert.ok(
  target &&
    target.source === process.env.PR_ROOT_SOURCE &&
    target.tree === process.env.PR_ROOT_TREE,
);
assert.ok(["images", "settings"].includes(target.kind));
assert.ok(["before", "after"].includes(target.variant));
const output = join(root, "root-source-evidence", target.id);
const runnerTemp = resolve(process.env.RUNNER_TEMP);
const live = join(
  runnerTemp,
  "root-source-evidence-" +
    process.env.GITHUB_RUN_ID +
    "-" +
    process.env.GITHUB_RUN_ATTEMPT +
    "-" +
    target.id,
);
const liveData = join(live, "data");
// Vite permits browser screenshots within the application workspace. This
// writer directory is deliberately outside the uploaded artifact tree.
const liveMedia = join(
  root,
  ".pr-root-live-media",
  process.env.GITHUB_RUN_ID + "-" + process.env.GITHUB_RUN_ATTEMPT + "-" + target.id,
);
assert.notEqual(root, driverRoot);
const digest = (data, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
const blob = (data) =>
  digest(Buffer.concat([Buffer.from("blob " + data.length + "\0"), data]), "sha1");
const save = (name, data) =>
  writeFileSync(join(output, name), JSON.stringify(data, null, 2) + "\n");
const read = (name) => JSON.parse(readFileSync(join(output, name), "utf8"));
const commands = [];
function git(args, cwd = root) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 10 * 1024 * 1024,
  });
  commands.push({
    executable: "git",
    args,
    cwd,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, JSON.stringify(commands.at(-1)));
  return result.stdout.trim();
}
function sourceGuard() {
  assert.equal(git(["rev-parse", "HEAD"]), target.source);
  assert.equal(git(["rev-parse", "HEAD^{tree}"]), target.tree);
  assert.equal(git(["diff", "HEAD", "--exit-code", "--"]), "");
  assert.equal(git(["status", "--porcelain", "--untracked-files=no"]), "");
  return target.paths.map((path) => {
    const bytes = readFileSync(join(root, path));
    const expected = git(["rev-parse", "HEAD:" + path]);
    assert.equal(blob(bytes), expected);
    return { path, bytes: bytes.length, blob: expected, sha256: digest(bytes) };
  });
}
function driverGuard() {
  const head = git(["rev-parse", "HEAD"], driverRoot);
  assert.equal(head, process.env.GITHUB_SHA);
  assert.equal(git(["diff", "HEAD", "--exit-code", "--"], driverRoot), "");
  const paths = [
    ".github/workflows/pr-root-source-evidence.yml",
    ...readdirSync(scripts).map((name) => "scripts/pr-root-source-evidence/" + name),
  ];
  const files = paths.map((path) => {
    const bytes = readFileSync(join(driverRoot, path));
    assert.equal(blob(bytes), git(["rev-parse", "HEAD:" + path], driverRoot));
    return { path, bytes: bytes.length, blob: blob(bytes), sha256: digest(bytes) };
  });
  return { head, tree: git(["rev-parse", "HEAD^{tree}"], driverRoot), files };
}
function commonFixture(key) {
  const spec = fixtures[key];
  const bytes = readFileSync(join(driverRoot, spec.path));
  assert.equal(blob(bytes), spec.blob);
  assert.equal(digest(bytes), spec.sha256);
  assert.equal(git(["rev-parse", "HEAD:" + spec.path], driverRoot), spec.blob);
  return bytes.toString("utf8");
}
function insert(source, anchor, addition) {
  assert.equal(source.split(anchor).length, 2, "One exact canonical insertion anchor is required.");
  const observed = source.replace(anchor, addition + anchor);
  assert.equal(
    observed.replace(addition, ""),
    source,
    "The complete original fixture must be recoverable.",
  );
  return observed;
}
function overlay(path, content, manifest) {
  assert.equal(existsSync(join(root, path)), false, "Refusing to replace " + path);
  assert.equal(git(["ls-files", "--", path]), "");
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content, { flag: "wx" });
  manifest.overlays.push({ path, bytes: Buffer.byteLength(content), sha256: digest(content) });
  writeFileSync(join(output, "observed-" + path.split("/").at(-1)), content, { flag: "wx" });
}
function appendEnvironment(values) {
  assert.ok(process.env.GITHUB_ENV);
  for (const [key, value] of Object.entries(values)) {
    assert.ok(!String(value).includes("\n"));
    appendFileSync(process.env.GITHUB_ENV, key + "=" + value + "\n");
  }
}
function prepareSettings(manifest) {
  const original = commonFixture("settings");
  const canonicalAddition = readFileSync(join(scripts, "settings-case.tsx"), "utf8");
  const canonical = original + canonicalAddition;
  if (target.variant === "after")
    assert.equal(readFileSync(join(root, fixtures.settings.path), "utf8"), canonical);
  const observer = readFileSync(join(scripts, "settings-observer.ts"), "utf8");
  const changes = [
    [
      '  const args = account.getByRole("textbox", { name: /^Codex launch args/u });',
      '  await captureRootProviderSettings("initial");\n  const args = account.getByRole("textbox", { name: /^Codex launch args/u });\n  expect(args.elements()).toHaveLength(1);',
    ],
    [
      "    .toHaveValue(homePath);\n});",
      '    .toHaveValue(homePath);\n  await captureRootProviderSettings("saved");\n});',
    ],
  ];
  let observedCase = canonicalAddition;
  for (const [before, after] of changes) {
    assert.equal(observedCase.split(before).length, 2);
    observedCase = observedCase.replace(before, after);
  }
  let reversed = observedCase;
  for (const [before, after] of [...changes].reverse()) reversed = reversed.replace(after, before);
  assert.equal(reversed, canonicalAddition);
  writeFileSync(join(output, "original-settings.browser.tsx"), canonical, { flag: "wx" });
  overlay(
    "apps/web/src/components/settings/PrRootSettingsEvidence.browser.tsx",
    original + observer + observedCase,
    manifest,
  );
}
function verifyOverlays(manifest) {
  for (const entry of manifest.overlays) {
    const bytes = readFileSync(join(root, entry.path));
    assert.equal(bytes.length, entry.bytes);
    assert.equal(digest(bytes), entry.sha256);
  }
}
const command = process.argv[2];
if (command === "prepare") {
  assert.equal(existsSync(output), false);
  assert.equal(existsSync(live), false);
  assert.equal(existsSync(liveMedia), false);
  mkdirSync(output, { recursive: true });
  mkdirSync(liveData, { recursive: true });
  mkdirSync(liveMedia, { recursive: true });
  const sourceFiles = sourceGuard();
  const driver = driverGuard();
  const manifest = {
    target,
    sourceFiles,
    driver,
    overlays: [],
    livePaths: { reports: live, data: liveData, media: liveMedia, artifact: output },
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    node: process.version,
    qualification:
      "Source-pinned diagnostic evidence. Complete canonical fixtures are retained; only selected new cases execute. Before failures remain actual failures and must match the exact expected regression. No live provider, packaged desktop or native local-image HTTP route claim.",
  };
  if (target.kind === "images") {
    const original = commonFixture("server");
    const addition = readFileSync(join(scripts, "projection-case.ts"), "utf8");
    const observed = insert(
      original,
      '  it("replays a committed text batch exactly once after an uncertain append and ingestion restart", async () => {',
      addition,
    );
    writeFileSync(join(output, "original-ingestion.test.ts"), original, { flag: "wx" });
    overlay(
      "apps/server/src/orchestration/Layers/PrRootProjectionEvidence.test.ts",
      observed,
      manifest,
    );
  } else prepareSettings(manifest);
  overlay(
    "apps/web/vitest.pr-root-source-evidence.config.ts",
    readFileSync(join(scripts, "browser.config.ts"), "utf8"),
    manifest,
  );
  save("provenance.json", manifest);
  save("output-snapshots.json", {
    files: [],
    qualification:
      "Only bounded stable copies enter the artifact tree; live writer paths are separate.",
  });
  save("prepare-commands.json", commands);
  appendEnvironment({
    PR_ROOT_OUTPUT: liveData,
    PR_ROOT_LIVE: live,
    PR_ROOT_KIND: target.kind,
    PR_ROOT_APPLICATION_ROOT: root,
    VITE_PR_ROOT_OUTPUT: liveMedia,
    VITE_PR_ROOT_SOURCE: target.source,
    VITE_PR_ROOT_TREE: target.tree,
  });
} else if (command === "prepare-browser") {
  assert.equal(target.kind, "images");
  const manifest = read("provenance.json");
  assert.deepEqual(sourceGuard(), manifest.sourceFiles);
  assert.deepEqual(driverGuard(), manifest.driver);
  verifyOverlays(manifest);
  assert.equal(
    process.env.PR_ROOT_SERVER_OUTCOME,
    "success",
    "Projection execution did not complete normally.",
  );
  const snapshots = read("output-snapshots.json");
  try {
    for (const kind of ["view", "generation"]) {
      const name = "projection-" + kind + ".json";
      freezeFile(join(liveData, name), output, name, snapshots.files, 20 * 1024 * 1024);
    }
  } finally {
    save("output-snapshots.json", snapshots);
  }
  const cases = ["view", "generation"].map((kind) => {
    const bytes = boundedStableRead(
      join(output, "projection-" + kind + ".json"),
      20 * 1024 * 1024,
    ).bytes;
    const entry = JSON.parse(bytes.toString("utf8"));
    assert.equal(entry.kind, kind);
    assert.equal(entry.source, target.source);
    assert.equal(entry.sourceTree, target.tree);
    assert.deepEqual(entry.snapshot.threads, [entry.projectedThread]);
    assert.deepEqual(entry.snapshot.projects, entry.commandReadModel.projects);
    assert.deepEqual(entry.snapshot.spaces, entry.commandReadModel.spaces);
    assert.deepEqual(entry.projectedThread.messages, entry.commandReadModel.threads[0].messages);
    const image = Buffer.from(entry.imageBase64, "base64");
    assert.deepEqual(image, readFileSync(join(root, "assets/beta/beta-web-apple-touch-180.png")));
    return { ...entry, projectionSha256: digest(bytes) };
  });
  overlay(
    "apps/web/src/components/PrRootProjectionEvidence.data.json",
    JSON.stringify({ cases }, null, 2) + "\n",
    manifest,
  );
  const original = commonFixture("chat");
  const importLine = 'import rootProjectionEvidence from "./PrRootProjectionEvidence.data.json";\n';
  const addition = readFileSync(join(scripts, "chat-case.tsx"), "utf8");
  const anchor = 'describe("ChatView transcript geometry (full app)", () => {\n';
  assert.equal(original.split(anchor).length, 2);
  const observed = importLine + original.replace(anchor, anchor + addition);
  assert.equal(observed.slice(importLine.length).replace(addition, ""), original);
  writeFileSync(join(output, "original-ChatView.browser.tsx"), original, { flag: "wx" });
  overlay("apps/web/src/components/PrRootSourceEvidence.browser.tsx", observed, manifest);
  save("provenance.json", manifest);
  save("prepare-browser-commands.json", commands);
} else if (command === "verify") {
  const errors = [];
  const attempt = (action) => {
    try {
      return action();
    } catch (error) {
      errors.push(String(error));
    }
  };
  const manifest = read("provenance.json");
  attempt(() => assert.deepEqual(sourceGuard(), manifest.sourceFiles));
  attempt(() => assert.deepEqual(driverGuard(), manifest.driver));
  attempt(() => verifyOverlays(manifest));
  const outcomes = {
    server: process.env.PR_ROOT_SERVER_OUTCOME,
    browser: process.env.PR_ROOT_BROWSER_OUTCOME,
  };
  attempt(() =>
    assert.equal(
      outcomes.server,
      target.kind === "images" ? "success" : "skipped",
      "Projection step failed, timed out or was cancelled.",
    ),
  );
  attempt(() =>
    assert.equal(outcomes.browser, "success", "Browser step failed, timed out or was cancelled."),
  );
  const snapshots = read("output-snapshots.json");
  attempt(() => freezeDirectory(liveData, output, snapshots.files, 40 * 1024 * 1024));
  attempt(() => freezeDirectory(liveMedia, output, snapshots.files, 100 * 1024 * 1024));
  for (const phase of target.kind === "images" ? ["server", "browser"] : ["browser"]) {
    attempt(() =>
      freezeFile(
        join(live, phase + ".json"),
        output,
        phase + ".json",
        snapshots.files,
        20 * 1024 * 1024,
      ),
    );
  }
  save("output-snapshots.json", snapshots);
  save("live-output-cutoff.json", {
    outcomes,
    cutoffUtc: new Date().toISOString(),
    errors: [...errors],
    qualification:
      "Timeout, cancellation, missing output, unsafe files or writes during a cutoff make evidence incomplete. Later writes can affect only separate live paths, never these frozen copies.",
  });
  const reportRecords = [];
  for (const phase of target.kind === "images" ? ["server", "browser"] : ["browser"])
    attempt(() => {
      const bytes = boundedStableRead(join(output, phase + ".json"), 20 * 1024 * 1024).bytes;
      assert.ok(bytes.length > 0);
      const report = JSON.parse(bytes.toString("utf8"));
      const exits = read(phase + "-exit.json");
      assert.equal(exits.tee, 0);
      assert.ok(Number.isInteger(exits.process));
      const all = report.testResults.flatMap((file) => file.assertionResults);
      const pattern =
        target.kind === "settings"
          ? /saves raw Codex launch args without changing account paths$/
          : new RegExp(
              "source UI evidence " +
                (phase === "server" ? "exports" : "renders") +
                " (view|generation) projection$",
            );
      const selected = all.filter((test) => pattern.test(test.fullName));
      assert.equal(selected.length, target.kind === "settings" ? 1 : 2);
      const expectedFailure = target.variant === "before";
      for (const test of selected) {
        const shouldFail =
          expectedFailure && (target.kind === "settings" || /view projection$/.test(test.fullName));
        assert.equal(test.status, shouldFail ? "failed" : "passed", test.fullName);
      }
      assert.equal(exits.process, expectedFailure ? 1 : 0);
      assert.equal(report.success, !expectedFailure);
      assert.equal(report.numFailedTests, expectedFailure ? 1 : 0);
      assert.equal(report.numPassedTests, selected.length - (expectedFailure ? 1 : 0));
      assert.ok(
        all
          .filter((test) => !selected.includes(test))
          .every((test) => ["skipped", "pending"].includes(test.status)),
      );
      reportRecords.push({
        phase,
        bytes: bytes.length,
        sha256: digest(bytes),
        immutableSnapshot: true,
        actualExit: exits,
        selected: selected.map(({ fullName, status }) => ({ fullName, status })),
        filteredCases: all.length - selected.length,
      });
    });
  const observations =
    attempt(() => {
      const log = boundedStableRead(join(output, "browser.log"), 20 * 1024 * 1024).bytes.toString(
        "utf8",
      );
      const prefix = "PR_ROOT_OBSERVATION ";
      return log
        .split("\n")
        .filter((line) => line.includes(prefix))
        .map((line) =>
          JSON.parse(
            line
              .slice(line.indexOf(prefix) + prefix.length)
              .replace(/\x1b\[[0-9;]*m/g, "")
              .trim(),
          ),
        );
    }) ?? [];
  const stages =
    target.kind === "images"
      ? ["view-result", "generation-control"]
      : target.variant === "before"
        ? ["settings-initial"]
        : ["settings-initial", "settings-saved"];
  attempt(() => {
    assert.deepEqual(observations.map((x) => x.stage).toSorted(), stages.toSorted());
    assert.equal(new Set(observations.map((x) => x.stage)).size, stages.length);
    for (const row of observations) {
      assert.equal(row.source, target.source);
      assert.equal(row.sourceTree, target.tree);
      assert.deepEqual(row.viewport, { width: 960, height: 1100 });
      if (target.kind === "images") {
        const kind = row.stage === "view-result" ? "view" : "generation";
        const bytes = readFileSync(join(output, "projection-" + kind + ".json"));
        const projection = JSON.parse(bytes.toString("utf8"));
        assert.equal(row.projectionSha256, digest(bytes));
        assert.deepEqual(
          row.rawMessageTexts,
          projection.projectedThread.messages.map((message) => message.text),
        );
        assert.equal(row.imageCount, kind === "generation" || target.variant === "before" ? 1 : 0);
      } else {
        const args = row.fields.filter((field) => field.label?.startsWith("Codex launch args"));
        assert.equal(args.length, target.variant === "after" ? 1 : 0);
        if (row.stage === "settings-saved")
          assert.equal(args[0].value, ' -c model_provider="api token" -- --value trailing\\ ');
      }
    }
    const pngs = readdirSync(output).filter((name) => name.endsWith(".png"));
    assert.deepEqual(pngs.toSorted(), stages.map((stage) => stage + ".png").toSorted());
    for (const name of pngs) {
      const bytes = readFileSync(join(output, name));
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.equal(bytes.readUInt32BE(16), 960);
      assert.equal(bytes.readUInt32BE(20), 1100);
    }
    const videos = readdirSync(join(output, "video"));
    assert.equal(videos.length, 1);
    for (const name of videos) {
      assert.ok(name.endsWith(".webm"));
      assert.equal(
        readFileSync(join(output, "video", name))
          .subarray(0, 4)
          .toString("hex"),
        "1a45dfa3",
      );
    }
  });
  save("verification.json", {
    target,
    errors,
    reportRecords,
    observations,
    qualification: manifest.qualification,
  });
  save("verify-commands.json", commands);
  const inventory = [];
  let total = 0;
  function walk(directory, prefix = "") {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const relative = prefix + name;
      const info = lstatSync(path);
      assert.equal(info.isSymbolicLink(), false);
      if (info.isDirectory()) walk(path, relative + "/");
      else {
        assert.ok(info.isFile());
        const bytes = boundedStableRead(path, 100 * 1024 * 1024 - total).bytes;
        total += bytes.length;
        assert.ok(total <= 100 * 1024 * 1024);
        inventory.push({
          path: relative,
          bytes: bytes.length,
          sha256: digest(bytes),
          blob: blob(bytes),
        });
      }
    }
  }
  walk(output);
  save("manifest.json", { target, complete: errors.length === 0, files: inventory });
  assert.deepEqual(errors, []);
} else throw new Error("Unknown evidence command.");

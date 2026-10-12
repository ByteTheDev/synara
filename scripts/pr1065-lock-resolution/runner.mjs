import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedStableRead, freezeFile } from "./snapshots.mjs";

const workspace = resolve(process.env.GITHUB_WORKSPACE);
const source = join(workspace, "source");
const driver = join(workspace, "driver");
const evidence = join(workspace, "pr1065-lock-evidence");
const here = dirname(fileURLToPath(import.meta.url));
const input = JSON.parse(boundedStableRead(join(here, "inputs.json"), 256 * 1024).bytes);
const paths = [
  ".github/workflows/pr1065-lock-resolution.yml",
  "scripts/pr1065-lock-resolution/README.md",
  "scripts/pr1065-lock-resolution/inputs.json",
  "scripts/pr1065-lock-resolution/runner.mjs",
  "scripts/pr1065-lock-resolution/snapshots.mjs",
];
const hash = (data) => createHash("sha256").update(data).digest("hex");
const blob = (data) => createHash("sha1").update("blob " + data.length + "\0").update(data).digest("hex");
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const write = (path, value) => writeFileSync(path, json(value), { flag: "wx" });
const read = (path, limit = 2 * 1024 * 1024) => boundedStableRead(path, limit).bytes;
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
  timeout: 10_000, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024,
});
const phase = process.argv[2];
assert.equal(process.env.GITHUB_REPOSITORY, "Emanuele-web04/synara");
assert.equal(input.format, 1);
assert.equal(input.baseFiles.length, 14);
assert.equal(input.candidateManifests.length, 9);
assert.equal(input.allManifestPaths.length, 14);
assert.equal(typeof Bun.JSONC.parse, "function");

function safeRelative(path) {
  assert.ok(path && !isAbsolute(path) && !path.includes("\\") &&
    !path.split("/").some((part) => part === ".." || part === "." || !part));
  return path;
}

function checked(data, declaration) {
  assert.equal(data.length, declaration.bytes);
  assert.equal(hash(data), declaration.sha256);
  assert.equal(blob(data), declaration.gitBlob);
  return data;
}

function sourceGuard() {
  assert.equal(git(source, "rev-parse", "HEAD").toString().trim(), input.source.commit);
  assert.equal(git(source, "rev-parse", "HEAD^{tree}").toString().trim(), input.source.tree);
  git(source, "diff", "--exit-code", "HEAD", "--");
  assert.equal(git(source, "status", "--porcelain=v1", "--untracked-files=all").length, 0);
  return input.baseFiles.map((item) => {
    assert.equal(item.mode, "100644");
    const data = checked(read(join(source, safeRelative(item.path))), item);
    return { path: item.path, bytes: data.length, sha256: hash(data), gitBlob: blob(data) };
  });
}

function driverGuard() {
  assert.equal(git(driver, "rev-parse", "HEAD").toString().trim(), process.env.GITHUB_SHA);
  git(driver, "diff", "--exit-code", "HEAD", "--");
  assert.equal(git(driver, "status", "--porcelain=v1", "--untracked-files=all").length, 0);
  return paths.map((path) => {
    const data = read(join(driver, path));
    assert.deepEqual(data, git(driver, "show", "HEAD:" + path));
    return { path, bytes: data.length, sha256: hash(data), gitBlob: blob(data) };
  });
}

function guards() {
  const observed = execFileSync("bun", ["--version"], {
    timeout: 10_000, killSignal: "SIGKILL", encoding: "utf8",
  }).trim();
  assert.equal(observed, input.bunVersion);
  return {
    source: input.source, original: input.original, sourceFiles: sourceGuard(),
    driver: process.env.GITHUB_SHA, driverFiles: driverGuard(),
    bunVersion: observed, run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT, observedAt: new Date().toISOString(),
  };
}

function environment() {
  const privateRoot = process.env.PR1065_PRIVATE;
  const graph = process.env.PR1065_GRAPH;
  assert.ok(privateRoot && graph && isAbsolute(privateRoot) && isAbsolute(graph));
  const temp = resolve(process.env.RUNNER_TEMP);
  assert.ok(privateRoot.startsWith(temp + "/") && graph.startsWith(temp + "/"));
  const state = JSON.parse(read(join(privateRoot, "state.json"), 64 * 1024));
  assert.equal(state.privateRoot, privateRoot);
  assert.equal(state.graph, graph);
  assert.equal(state.source.commit, input.source.commit);
  assert.equal(state.driver, process.env.GITHUB_SHA);
  return state;
}

function graphManifests(graph) {
  const expected = new Map(input.currentManifestPaths.map((path) => [
    path, read(join(source, safeRelative(path))),
  ]));
  for (const item of input.candidateManifests) {
    const data = checked(Buffer.from(item.content), item);
    expected.set(safeRelative(item.path), data);
  }
  assert.deepEqual([...expected.keys()].sort(), input.allManifestPaths);
  for (const [path, bytes] of expected) assert.deepEqual(read(join(graph, path)), bytes);
  for (const item of input.baseFiles.filter((item) =>
    !item.path.endsWith("package.json") && item.path !== "bun.lock"
  )) checked(read(join(graph, item.path)), item);
  return expected;
}

function validateLock(bytes, graph) {
  const seed = Bun.JSONC.parse(read(join(source, "bun.lock")).toString());
  const lock = Bun.JSONC.parse(bytes.toString());
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.configVersion, seed.configVersion);
  for (const field of ["catalog", "catalogs", "overrides", "patchedDependencies"]) {
    assert.deepEqual(lock[field] ?? null, seed[field] ?? null, "Changed root lock field: " + field);
  }
  const manifests = graphManifests(graph);
  const expectedPaths = [...manifests.keys()].map((path) =>
    path === "package.json" ? "" : path.slice(0, -"/package.json".length)
  ).sort();
  assert.deepEqual(Object.keys(lock.workspaces).sort(), expectedPaths);
  for (const [path, value] of manifests) {
    const manifest = JSON.parse(value);
    const key = path === "package.json" ? "" : path.slice(0, -"/package.json".length);
    const actual = lock.workspaces[key];
    for (const field of ["name", "version", "dependencies", "devDependencies",
      "optionalDependencies", "peerDependencies"]) {
      assert.deepEqual(actual[field] ?? null, manifest[field] ?? null, key + ": " + field);
    }
  }
  assert.ok(lock.packages && typeof lock.packages === "object" && !Array.isArray(lock.packages));
  const changes = [...new Set([...Object.keys(seed.packages), ...Object.keys(lock.packages)])]
    .sort().flatMap((name) => JSON.stringify(seed.packages[name]) === JSON.stringify(lock.packages[name])
      ? [] : [{ name, before: seed.packages[name] ?? null, after: lock.packages[name] ?? null }]);
  return {
    bytes: bytes.length, sha256: hash(bytes), gitBlob: blob(bytes),
    workspaceCount: expectedPaths.length, packageCount: Object.keys(lock.packages).length,
    packageChanges: changes, unchangedRootLockFields: true,
  };
}

if (phase === "prepare") {
  const guard = guards();
  assert.ok(!existsSync(evidence), "Evidence directory already exists.");
  const temp = resolve(process.env.RUNNER_TEMP);
  const owned = mkdtempSync(join(temp, "pr1065-lock-"));
  const privateRoot = join(owned, "private");
  const graph = join(owned, "graph");
  mkdirSync(privateRoot);
  mkdirSync(graph);
  for (const item of input.baseFiles) {
    const target = join(graph, safeRelative(item.path));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, checked(read(join(source, item.path)), item), { flag: "wx" });
  }
  for (const item of input.candidateManifests) {
    const target = join(graph, safeRelative(item.path));
    mkdirSync(dirname(target), { recursive: true });
    assert.equal(existsSync(target), item.baseBlob !== null);
    if (item.baseBlob !== null) assert.equal(blob(read(target)), item.baseBlob);
    writeFileSync(target, checked(Buffer.from(item.content), item));
  }
  graphManifests(graph);
  const state = {
    privateRoot, graph, source: input.source, original: input.original,
    driver: process.env.GITHUB_SHA, qualification: input.qualification,
  };
  write(join(privateRoot, "state.json"), state);
  write(join(privateRoot, "prepare.json"), guard);
  for (const [key, value] of [["PR1065_PRIVATE", privateRoot], ["PR1065_GRAPH", graph]]) {
    assert.ok(!/[\r\n]/u.test(value));
    appendFileSync(process.env.GITHUB_ENV, key + "=" + value + "\n");
  }
  console.log(json({ phase, manifests: input.allManifestPaths.length, source: input.source }));
} else if (phase === "resolved") {
  const state = environment();
  const guard = guards();
  const bytes = read(join(state.graph, "bun.lock"));
  const result = validateLock(bytes, state.graph);
  writeFileSync(join(state.privateRoot, "resolved.lock"), bytes, { flag: "wx" });
  write(join(state.privateRoot, "resolution.json"), { ...result, guard });
  console.log(json({ phase, ...result, packageChanges: result.packageChanges.map((item) => item.name) }));
} else if (phase === "frozen") {
  const state = environment();
  const guard = guards();
  const bytes = read(join(state.graph, "bun.lock"));
  assert.deepEqual(bytes, read(join(state.privateRoot, "resolved.lock")), "Frozen install rewrote lock.");
  const result = validateLock(bytes, state.graph);
  write(join(state.privateRoot, "frozen.json"), { ...result, guard, lockUnchanged: true });
  console.log(json({ phase, sha256: result.sha256, workspaceCount: result.workspaceCount }));
} else if (phase === "finish") {
  mkdirSync(evidence);
  const records = [];
  const failures = [];
  const outcomes = Object.fromEntries(["PREPARE", "RESOLVE", "INSPECT", "FROZEN", "VERIFY"]
    .map((name) => [name.toLowerCase(), process.env[name + "_OUTCOME"] ?? "missing"]));
  let state;
  let finalGuard;
  try { state = environment(); } catch (error) { failures.push("state: " + String(error)); }
  try { finalGuard = guards(); } catch (error) { failures.push("source guard: " + String(error)); }
  if (state) {
    for (const [name, limit] of [
      ["state.json", 64 * 1024], ["prepare.json", 128 * 1024],
      ["resolve.log", 8 * 1024 * 1024], ["resolve-exit.json", 4096],
      ["resolution.json", 8 * 1024 * 1024], ["resolved.lock", 2 * 1024 * 1024],
      ["frozen.log", 8 * 1024 * 1024], ["frozen-exit.json", 4096],
      ["frozen.json", 8 * 1024 * 1024],
    ]) {
      try { freezeFile(join(state.privateRoot, name), evidence, name, records, limit); }
      catch (error) { failures.push(name + ": " + String(error)); }
    }
    try { freezeFile(join(state.graph, "bun.lock"), evidence, "final.lock", records, 2 * 1024 * 1024); }
    catch (error) { failures.push("final.lock: " + String(error)); }
    for (const name of ["resolve", "frozen"]) {
      try {
        const actual = JSON.parse(read(join(evidence, name + "-exit.json"), 4096));
        assert.equal(actual.bunExit, 0);
        assert.equal(actual.teeExit, 0);
      } catch (error) { failures.push(name + " actual exit: " + String(error)); }
    }
    try {
      const final = read(join(evidence, "final.lock"));
      assert.deepEqual(final, read(join(evidence, "resolved.lock")));
      validateLock(final, state.graph);
    } catch (error) { failures.push("final lock: " + String(error)); }
  }
  for (const [name, outcome] of Object.entries(outcomes)) {
    if (outcome !== "success") failures.push(name + " step outcome: " + outcome);
  }
  write(join(evidence, "snapshots.json"), { records, failures });
  write(join(evidence, "outcome.json"), {
    outcomes, failures, finalGuard, source: input.source, original: input.original,
    driver: process.env.GITHUB_SHA, success: failures.length === 0,
    qualification: input.qualification,
    retention: "One bounded stable snapshot per observed regular file. Missing, capped, replaced or changing output is a failure; no full descendant-log or application-lifecycle claim.",
  });
  const retained = [...records.map((item) => item.path), "snapshots.json", "outcome.json"];
  write(join(evidence, "manifest.json"), {
    files: retained.map((path) => {
      const data = read(join(evidence, path), 16 * 1024 * 1024);
      return { path, bytes: data.length, sha256: hash(data) };
    }),
  });
  console.log(json({ phase, outcomes, failures, snapshotCount: records.length }));
  assert.equal(failures.length, 0, "Lock diagnostic or evidence validation failed.");
} else {
  throw new Error("Unknown phase: " + phase);
}

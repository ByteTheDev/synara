import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, toNamespacedPath } from "node:path";
import { fileURLToPath } from "node:url";

const source = {
  commit: "a1b087d984a39cf9df936d5da9465db9e7679600",
  tree: "6011b0c1b9d93e2dcbf9b78b79c981d587cf4a4b",
  fixture: "be5409007be3f448000f9d7aa714a0c32bb50d73",
};
const phase = process.env.GIT_FIXTURE_PHASE;
assert(phase === "original" || phase === "candidate");
assert(process.platform === "win32" || process.platform === "linux");
assert.equal(process.env.GITHUB_REPOSITORY, "Emanuele-web04/synara");
const workspace = process.cwd();
const driver = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = resolve(process.env.RUNNER_TEMP);
const output = join(temporary, `gitcore-fixture-${phase}`);
assert(!existsSync(output), "refuse an existing evidence directory");
mkdirSync(output);
const owned = mkdtempSync(join(temporary, `gitcore-fixture-input-${phase}-`));
const longPathRepositories = new Set();
const commands = [];
const cases = [];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const writeJSON = (name, value) =>
  writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`);

function git(cwd, args) {
  const startedAt = new Date().toISOString();
  const useShortProcessDirectory = longPathRepositories.has(cwd);
  const processArgs = useShortProcessDirectory
    ? ["-c", "core.longpaths=true", "-C", cwd, ...args]
    : args;
  const result = spawnSync("git", processArgs, {
    cwd: useShortProcessDirectory ? owned : cwd,
    encoding: "utf8",
    timeout: 15_000,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
  const entry = {
    cwd: cwd === workspace ? "source" : cwd === driver ? "driver" : cwd.slice(owned.length + 1),
    args,
    ...(useShortProcessDirectory
      ? { processDirectory: "owned temporary parent", processArgs }
      : {}),
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  commands.push(entry);
  return entry;
}

function successful(cwd, args) {
  const result = git(cwd, args);
  assert(!result.error && result.status === 0 && result.signal === null, `git ${args[0]} failed`);
  return result.stdout;
}

function sourceGuard() {
  assert.equal(successful(workspace, ["rev-parse", "HEAD"]).trim(), source.commit);
  assert.equal(successful(workspace, ["rev-parse", "HEAD^{tree}"]).trim(), source.tree);
  assert.equal(successful(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]), "");
  assert.equal(
    blob(readFileSync(join(workspace, "apps/server/src/git/Layers/GitCore.test.ts"))),
    source.fixture,
  );
  assert.equal(successful(driver, ["rev-parse", "HEAD"]).trim(), process.env.GITHUB_SHA);
  assert.equal(successful(driver, ["diff", "HEAD", "--"]), "");
  for (const path of [
    "scripts/gitcore-fixture-probe.mjs",
    "scripts/gitcore-fixture-probe.md",
    ".github/workflows/gitcore-fixture-probe.yml",
  ])
    assert.equal(
      blob(readFileSync(join(driver, path))),
      successful(driver, ["rev-parse", `HEAD:${path}`]).trim(),
    );
}

function repository(name, longPaths = false) {
  const cwd = join(owned, name);
  mkdirSync(cwd, { recursive: true });
  if (longPaths) longPathRepositories.add(cwd);
  successful(cwd, longPaths ? ["-c", "core.longpaths=true", "init"] : ["init"]);
  if (longPaths) successful(cwd, ["-c", "core.longpaths=true", "config", "core.longpaths", "true"]);
  successful(cwd, ["config", "user.email", "fixture@example.test"]);
  successful(cwd, ["config", "user.name", "Synthetic Git fixture"]);
  if (phase === "candidate") successful(cwd, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(cwd, "README.md"), "# test\n");
  successful(cwd, ["add", "."]);
  successful(cwd, ["commit", "-m", "synthetic initial fixture"]);
  return cwd;
}

function observe(name, run) {
  const start = commands.length;
  try {
    const details = run();
    cases.push({ name, status: "passed", details, commands: [start, commands.length] });
  } catch (error) {
    cases.push({
      name,
      status: "failed",
      error: { name: error.name, message: error.message, stack: error.stack },
      commands: [start, commands.length],
    });
  }
}

let fatal;
try {
  sourceGuard();
  writeJSON("provenance.json", {
    source,
    phase,
    driver: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    platform: process.platform,
    node: process.version,
    git: successful(workspace, ["--version"]).trim(),
    qualification:
      "Read-only source-pinned Git fixture diagnostic. It does not execute or replace GitCore's 144 production integration cases. All repositories and data are newly owned synthetic inputs; no Git network commands or actual browser/provider data.",
  });
  observe("literal LF checkout bytes", () => {
    const cwd = repository("line-endings");
    writeFileSync(join(cwd, "README.md"), "raw checkout change\n");
    successful(cwd, ["add", "README.md"]);
    successful(cwd, ["commit", "-m", "synthetic LF content"]);
    writeFileSync(join(cwd, "README.md"), "temporary replacement\n");
    successful(cwd, ["checkout", "--", "README.md"]);
    const bytes = readFileSync(join(cwd, "README.md"));
    const result = {
      hex: bytes.toString("hex"),
      localAutocrlf: git(cwd, ["config", "--local", "--get", "core.autocrlf"]),
    };
    writeJSON("line-endings.json", result);
    assert.equal(bytes.toString("utf8"), "raw checkout change\n");
    return result;
  });
  observe("ignored rename retains 100755", () => {
    const cwd = repository("executable-mode");
    writeFileSync(join(cwd, ".gitignore"), "renamed.sh\n");
    writeFileSync(join(cwd, "old.sh"), "echo unchanged\n".repeat(5));
    chmodSync(join(cwd, "old.sh"), 0o755);
    successful(cwd, ["add", "."]);
    if (phase === "candidate") successful(cwd, ["update-index", "--chmod=+x", "old.sh"]);
    successful(cwd, ["commit", "-m", "synthetic executable source"]);
    renameSync(join(cwd, "old.sh"), join(cwd, "renamed.sh"));
    successful(cwd, ["add", "-u"]);
    successful(cwd, ["add", "-f", "renamed.sh"]);
    if (phase === "candidate") successful(cwd, ["update-index", "--chmod=+x", "renamed.sh"]);
    const patch = successful(cwd, ["diff", "--cached", "--no-renames", "HEAD"]);
    assert(patch.includes("b/renamed.sh"));
    assert(patch.includes("new file mode 100755"));
    return { patch };
  });
  observe("literal numeric-colon index path", () => {
    const cwd = repository("numeric-colon");
    if (phase === "original") {
      writeFileSync(join(cwd, "1:foo.txt"), "literal filename\n");
      successful(cwd, ["add", "--", "1:foo.txt"]);
    } else {
      writeFileSync(join(cwd, "fixture-content.txt"), "literal filename\n");
      const object = successful(cwd, ["hash-object", "-w", "fixture-content.txt"]).trim();
      assert.match(object, /^[a-f0-9]{40}$/);
      // Import a valid version-2 Git index directly. Git for Windows rejects
      // DOS-drive-shaped paths in update-index even with protectNTFS=false,
      // while this case exercises reading an existing literal stage-zero entry.
      const name = Buffer.from("1:foo.txt", "utf8");
      const header = Buffer.alloc(12);
      header.write("DIRC", 0, "ascii");
      header.writeUInt32BE(2, 4);
      header.writeUInt32BE(1, 8);
      const padding = 8 - ((62 + name.length) % 8);
      const entry = Buffer.alloc(62 + name.length + padding);
      entry.writeUInt32BE(0o100644, 24);
      entry.writeUInt32BE(Buffer.byteLength("literal filename\n"), 36);
      Buffer.from(object, "hex").copy(entry, 40);
      entry.writeUInt16BE(name.length, 60);
      name.copy(entry, 62);
      const body = Buffer.concat([header, entry]);
      const index = Buffer.concat([body, createHash("sha1").update(body).digest()]);
      writeFileSync(join(cwd, ".git", "index"), index);
      writeJSON("numeric-colon-index.json", {
        formatVersion: 2,
        entries: 1,
        bytes: index.length,
        sha256: digest(index),
        path: name.toString("utf8"),
        object,
        mode: "100644",
        stage: 0,
        qualification:
          "Owned synthetic imported index; no Windows working-tree filename support is claimed.",
      });
    }
    const content = successful(cwd, ["show", ":0:1:foo.txt"]);
    assert.equal(content, "literal filename\n");
    return { content, index: successful(cwd, ["ls-files", "--stage"]) };
  });
  observe("exact trailing-space untracked filename", () => {
    // Keep the directory below MAX_PATH during Git's early -C, when config is
    // not loaded yet. The unchanged relative filename crosses MAX_PATH later.
    const segmentLength = 245 - join(owned, "trailing-space").length - 1;
    assert(segmentLength > 0 && segmentLength < 200, "unexpected owned path length");
    const directory =
      phase === "candidate"
        ? join("trailing-space", "x".repeat(segmentLength))
        : "trailing-space";
    if (phase === "candidate") {
      assert.equal(join(owned, directory).length, 245);
      assert(join(owned, directory, " spaced file.txt ").length >= 260);
    }
    const cwd = repository(directory, phase === "candidate");
    if (phase === "candidate") {
      successful(cwd, ["config", "core.protectNTFS", "false"]);
      successful(cwd, ["config", "core.longpaths", "true"]);
    }
    writeFileSync(join(cwd, " spaced file.txt "), "hello\n");
    const paths = readdirSync(cwd).filter((name) => name !== ".git");
    writeJSON("trailing-space-paths.json", {
      paths,
      cwdCharacters: cwd.length,
      qualification:
        "The candidate is an explicit extended-path experiment; short-directory failure remains retained and is not repaired by this probe.",
    });
    const result = git(cwd, [
      "diff",
      "--no-index",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      "/dev/null",
      " spaced file.txt ",
    ]);
    assert(
      !result.error && result.status === 1 && result.signal === null,
      "expected actual nonempty Git diff",
    );
    assert(result.stdout.includes("diff --git a/ spaced file.txt  b/ spaced file.txt "));
    assert(result.stdout.includes("+hello"));
    return { paths, patch: result.stdout };
  });
  observe("short-directory explicit native-path argument", () => {
    const cwd = repository("explicit-native-path");
    const filename = " spaced file.txt ";
    const physicalPath = join(cwd, filename);
    writeFileSync(physicalPath, "hello\n");
    const paths = readdirSync(cwd).filter((name) => name !== ".git");
    assert(paths.includes(filename), "the filesystem did not preserve the exact filename");
    assert.equal(readFileSync(physicalPath, "utf8"), "hello\n");
    const argument = toNamespacedPath(physicalPath);
    const result = git(cwd, [
      "diff",
      "--no-index",
      "--patch",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--",
      "/dev/null",
      argument,
    ]);
    writeJSON("explicit-native-path.json", {
      paths,
      argument,
      result,
      qualification:
        "Read-only owned synthetic absolute-path experiment. Its headers may contain the absolute namespace; this does not repair the original relative-path GitCore assertion.",
    });
    assert(
      !result.error && result.status === 1 && result.signal === null,
      "expected actual nonempty Git diff",
    );
    assert(result.stdout.includes(filename), "Git omitted the exact filename");
    assert(result.stdout.includes("+hello"), "Git omitted the actual file content");
    return { paths, argument, patch: result.stdout };
  });
  observe("filesystem monitor command starts", () => {
    const cwd = repository("fsmonitor-launch");
    const hook = join(cwd, ".git", "hooks", "fsmonitor");
    const marker = join(cwd, ".git", "fsmonitor-started");
    writeFileSync(hook, "#!/bin/sh\nprintf started > .git/fsmonitor-started\nexit 0\n");
    chmodSync(hook, 0o755);
    const command =
      phase === "candidate" ? `'${hook.replaceAll("\\", "/").replaceAll("'", "'\\''")}'` : hook;
    successful(cwd, ["config", "core.fsmonitor", command]);
    successful(cwd, ["status", "--porcelain=2", "--branch", "-z"]);
    assert(existsSync(marker), "filesystem monitor fixture did not start");
    assert.equal(readFileSync(marker, "utf8"), "started");
    return {
      command,
      marker: true,
      qualification:
        "Finite launch-path diagnostic only; it does not replace the original stalled-hook deadline/teardown tests.",
    };
  });
  sourceGuard();
} catch (error) {
  fatal = { name: error.name, message: error.message, stack: error.stack };
} finally {
  let cleanup;
  try {
    rmSync(owned, { recursive: true, force: true });
    cleanup = { removed: !existsSync(owned) };
  } catch (error) {
    cleanup = { removed: false, message: error.message };
  }
  const failed =
    Boolean(fatal) ||
    !cleanup.removed ||
    cases.length !== 6 ||
    cases.some((entry) => entry.status !== "passed");
  writeJSON("commands.json", commands);
  writeJSON("results.json", {
    source,
    phase,
    cases,
    fatal,
    cleanup,
    failed,
    qualification:
      "Original diagnostic failures remain failures. A candidate setup pass is not a GitCore test or Windows feature pass; the unchanged full 144-case suite remains separate.",
  });
  const files = readdirSync(output).map((path) => {
    const bytes = readFileSync(join(output, path));
    return { path, bytes: bytes.length, sha256: digest(bytes) };
  });
  writeJSON("manifest.json", { files });
  console.log(
    JSON.stringify({
      phase,
      platform: process.platform,
      cases: cases.map(({ name, status }) => ({ name, status })),
      fatal,
      cleanup,
      failed,
    }),
  );
  process.exitCode = failed ? 1 : 0;
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCES = {
  1652: {
    commit: "5512c114e3d97c7db79127ca9d9a7946b1bc7359",
    tree: "811232074a0784aa8edc8b603c723ff4a6c5ad1c",
    target: "AppImage,deb",
  },
  1720: {
    commit: "5107bcccc6eff36672d878958fc75ce4fe61bc05",
    tree: "a2c3f012f66d491ef634e982e03f212cf083c5a5",
    target: "AppImage,deb",
  },
  1823: {
    commit: "5b6b0c427863018f65f4b1113f4e1ad4076e1dab",
    tree: "3d6480b7f82e2a16bcf45c92f1cc597255d49cb3",
    target: "AppImage,deb,rpm",
  },
};
const branch = /^cleanup\/20261011\/pr-(1652|1720|1823)-linux-checkpoint-(production|beta)$/u.exec(
  process.env.GITHUB_REF_NAME ?? "",
);
assert.ok(branch, "Only the six explicitly owned diagnostic branches may select a source");
const pr = branch[1];
const flavor = branch[2];
const source = SOURCES[pr];
const root = process.cwd();
const driverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];
assert.ok(mode === "prepare" || mode === "verify");
assert.equal(driverRoot, join(root, ".pr-driver"));
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.ok(process.env.RUNNER_TEMP);
const output = join(process.env.RUNNER_TEMP, "linux-checkpoint-evidence");
mkdirSync(output, { recursive: true });
const commands = [];
const errors = [];
const receipt = {
  pr,
  source,
  flavor,
  driver: process.env.GITHUB_SHA,
  run: process.env.GITHUB_RUN_ID,
  attempt: process.env.GITHUB_RUN_ATTEMPT,
  mode,
  node: process.version,
  startedAt: new Date().toISOString(),
  publication: false,
  signingCredentialsPassed: false,
  qualification:
    "Exact-source Linux packages and a separately labelled same-run checkpoint replay. The canonical reusable workflow performs native startup. This helper verifies downloaded bytes and native package metadata without installing packages or running their maintainer scripts. No signed release, speedup or naturally failed-release claim.",
};
const hash = (data, algorithm = "sha256") => createHash(algorithm).update(data).digest("hex");
const blob = (data) => hash(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data]), "sha1");
const writeJson = (name, value) =>
  writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`);

function command(executable, args, cwd = root) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 2 * 1024 * 1024,
  });
  const record = {
    executable,
    args,
    cwd,
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  commands.push(record);
  writeJson("commands.json", commands);
  assert.equal(record.error, null, `Command failed: ${executable}`);
  assert.equal(record.signal, null, `Command was terminated: ${executable}`);
  assert.equal(record.status, 0, `Command exited unsuccessfully: ${executable}`);
  return record.stdout;
}

function guard() {
  assert.match(process.env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/u);
  assert.equal(command("git", ["rev-parse", "HEAD"]).trim(), source.commit);
  assert.equal(command("git", ["rev-parse", "HEAD^{tree}"]).trim(), source.tree);
  command("git", ["diff", "--exit-code", "HEAD", "--"]);
  assert.equal(command("git", ["status", "--porcelain", "--untracked-files=no"]).trim(), "");
  assert.equal(command("git", ["rev-parse", "HEAD"], driverRoot).trim(), process.env.GITHUB_SHA);
  command("git", ["diff", "--exit-code", "HEAD", "--"], driverRoot);
  const paths = [
    ".github/workflows/release-platform.yml",
    ".github/workflows/release.yml",
    "scripts/lib/release-artifact-checkpoint.ts",
    "scripts/lib/release-artifact-checkpoint.test.ts",
    "scripts/verify-packaged-desktop-startup.ts",
    "scripts/build-desktop-artifact.ts",
    "scripts/lib/release-build-scope.ts",
    "bun.lock",
    "package.json",
    "apps/server/package.json",
  ];
  return paths.map((relative) => {
    const bytes = readFileSync(join(root, relative));
    const expected = command("git", ["rev-parse", `HEAD:${relative}`]).trim();
    const actual = blob(bytes);
    assert.equal(actual, expected, `Source bytes changed: ${relative}`);
    return { path: relative, blob: actual, bytes: bytes.length, sha256: hash(bytes) };
  });
}

try {
  receipt.before = guard();
  receipt.git = command("git", ["--version"]).trim();
  const sourceVersion = JSON.parse(
    readFileSync(join(root, "apps/server/package.json"), "utf8"),
  ).version;
  assert.match(sourceVersion, /^\d+\.\d+\.\d+$/u);
  const components = sourceVersion.split(".").map(Number);
  assert.ok(components.every(Number.isSafeInteger));
  assert.ok(Number.isSafeInteger(components[2] + 1));
  const version =
    flavor === "beta"
      ? `${components[0]}.${components[1]}.${components[2] + 1}-beta.1`
      : sourceVersion;
  const lock = hash(readFileSync(join(root, "bun.lock")));
  Object.assign(receipt, { sourceVersion, version, lockfileSha256: lock });
  if (mode === "prepare") {
    const values = {
      pr,
      source_commit: source.commit,
      source_tree: source.tree,
      desktop_flavor: flavor,
      target: source.target,
      version,
      lockfile_sha256: lock,
    };
    for (const [key, value] of Object.entries(values)) {
      assert.ok(!/[\r\n]/u.test(value));
      appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    }
  } else {
    const assets = join(process.env.RUNNER_TEMP, "qualified-packages");
    assert.equal(
      existsSync(join(root, "node_modules")),
      false,
      "Verification must not install a workspace graph",
    );
    assert.equal(existsSync(join(root, "scripts/node_modules")), false);
    const { verifyReleaseArtifactCheckpoint } = await import(
      pathToFileURL(join(root, "scripts/lib/release-artifact-checkpoint.ts")).href
    );
    const manifest = await verifyReleaseArtifactCheckpoint({
      assetsDirectory: assets,
      platform: "linux",
      arch: "x64",
      target: source.target,
      version,
      flavor,
      sourceCommit: source.commit,
      sourceTag: null,
      lockfileSha256: lock,
      publication: false,
      allowUnsignedWindowsPublication: false,
    });
    receipt.checkpoint = { verified: true, manifest };
    const expectedName = flavor === "beta" ? "synara-desktop-beta" : "synara-desktop";
    const expectedVersion = version.replaceAll("-", "~");
    const deb = manifest.artifacts.find((file) => file.fileName.endsWith(".deb"));
    assert.ok(deb, "The actual declared Debian package must be retained");
    const debMetadata = command("dpkg-deb", [
      "--show",
      "--showformat=${Package}\n${Version}\n${Architecture}\n",
      join(assets, deb.fileName),
    ])
      .trimEnd()
      .split("\n");
    assert.deepEqual(debMetadata, [expectedName, expectedVersion, "amd64"]);
    receipt.debian = { file: deb.fileName, metadata: debMetadata };
    if (source.target.includes("rpm")) {
      const rpm = manifest.artifacts.find((file) => file.fileName.endsWith(".rpm"));
      assert.ok(rpm, "The actual declared RPM package must be retained");
      const rpmMetadata = command("rpm", [
        "--query",
        "--package",
        "--queryformat",
        "%{NAME}\n%{VERSION}\n%{ARCH}\n",
        join(assets, rpm.fileName),
      ])
        .trimEnd()
        .split("\n");
      assert.deepEqual(rpmMetadata, [expectedName, expectedVersion, "x86_64"]);
      receipt.rpm = { file: rpm.fileName, metadata: rpmMetadata };
    }
    const files = [];
    for (const entry of manifest.artifacts) {
      const digest = createHash("sha256");
      for await (const chunk of createReadStream(join(assets, entry.fileName)))
        digest.update(chunk);
      assert.equal(digest.digest("hex"), entry.sha256);
      files.push(entry);
    }
    receipt.actualPackages = files;
    const provenance = readFileSync(join(assets, "artifact-linux-x64.provenance.json"));
    writeFileSync(join(output, "artifact-linux-x64.provenance.json"), provenance);
    receipt.provenanceSha256 = hash(provenance);
    receipt.workspaceInstallationSkipped = true;
  }
  receipt.after = guard();
} catch (error) {
  errors.push(error.stack ?? String(error));
} finally {
  receipt.finishedAt = new Date().toISOString();
  receipt.errors = errors;
  writeJson("receipt.json", receipt);
  const files = readdirSync(output)
    .sort()
    .filter((name) => name !== "verified.json")
    .map((name) => {
      const bytes = readFileSync(join(output, name));
      return { name, bytes: bytes.length, sha256: hash(bytes) };
    });
  writeJson("verified.json", { source, driver: process.env.GITHUB_SHA, mode, files, errors });
  if (errors.length) console.error(errors.join("\n"));
  process.exitCode = errors.length ? 1 : 0;
}

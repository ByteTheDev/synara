// Inspect actual DMG and update ZIP metadata, keeping canonical startup separate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const identity = {
  sha: "fc3cd0c5e744041108b5d9109730cba1ded9c4ee",
  tree: "e462bf97f33a79c2fedf40172ae35d87da615184",
  lock: "05f39e33bc5c54ceb31eba6925c7e6c065648effedd26fbeb0f5deda4d3bac2e",
  version: "1.0.2",
  minimum: "13.0",
};
const source = process.cwd();
const driver = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const arch = process.env.MINIMUM_ARCH;
assert.ok(["arm64", "x64"].includes(arch));
assert.equal(process.platform, "darwin");
assert.equal(process.arch, arch);
const phase = process.argv[2];
assert.ok(["prepare", "inspect", "verify"].includes(phase));
const evidence = join(process.env.RUNNER_TEMP, "macos-minimum-evidence");
const packages = join(process.env.RUNNER_TEMP, "macos-minimum-packages");
const icon = join(process.env.RUNNER_TEMP, "macos-minimum-icon");
mkdirSync(evidence, { recursive: true });
const save = (name, value) =>
  writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + "\n");
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function command(
  label,
  program,
  args,
  { cwd = source, env = process.env, input, timeout = 30_000 } = {},
) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    input,
    timeout,
    shell: false,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  writeFileSync(
    join(evidence, `${phase}-${label}.log`),
    (result.stdout ?? "") + (result.stderr ?? ""),
  );
  save(`${phase}-${label}.json`, {
    program,
    args,
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${label}: ${result.stderr || result.stdout}`);
  return result.stdout ?? "";
}
async function sources() {
  assert.equal(command("source-head", "git", ["rev-parse", "HEAD"]).trim(), identity.sha);
  assert.equal(command("source-tree", "git", ["rev-parse", "HEAD^{tree}"]).trim(), identity.tree);
  command("source-diff", "git", ["diff", "--exit-code", "HEAD", "--"]);
  assert.equal(
    command("source-status", "git", ["status", "--porcelain=v1", "--untracked-files=all"]).trim(),
    "",
  );
  assert.equal(
    command("driver-head", "git", ["rev-parse", "HEAD"], { cwd: driver }).trim(),
    process.env.GITHUB_SHA,
  );
  assert.equal(
    command("driver-status", "git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: driver,
    }).trim(),
    "",
  );
  assert.equal(await digest(join(source, "bun.lock")), identity.lock);
  assert.equal(
    JSON.parse(readFileSync(join(source, "apps/server/package.json"), "utf8")).version,
    identity.version,
  );
  const paths = [
    "scripts/lib/desktop-platform-build-config.ts",
    "scripts/build-desktop-artifact-mac-config.test.ts",
    "scripts/verify-packaged-desktop-startup.ts",
    "scripts/lib/release-artifact-provenance.ts",
    "scripts/build-desktop-artifact.ts",
    "bun.lock",
  ];
  save(
    `${phase}-source-hashes.json`,
    Object.fromEntries(
      await Promise.all(paths.map(async (path) => [path, await digest(join(source, path))])),
    ),
  );
}
async function iconReceipt() {
  assert.equal(readFileSync(join(icon, "source-commit.txt"), "utf8").trim(), identity.sha);
  const checksum = readFileSync(join(icon, "Assets.car.sha256"), "utf8").trim();
  assert.match(checksum, /^[0-9a-f]{64} [ *]Assets\.car$/);
  assert.equal(await digest(join(icon, "Assets.car")), checksum.slice(0, 64));
  assert.ok(statSync(join(icon, "Assets.car")).size > 0);
  assert.equal(process.env.SYNARA_MAC_ICON_CATALOG, join(icon, "Assets.car"));
  return {
    sourceSha: identity.sha,
    sha256: checksum.slice(0, 64),
    bytes: statSync(join(icon, "Assets.car")).size,
  };
}
function regularFiles(directory) {
  return readdirSync(directory)
    .sort()
    .flatMap((name) => {
      const path = join(directory, name);
      const stat = lstatSync(path);
      return stat.isDirectory() ? regularFiles(path) : stat.isFile() ? [path] : [];
    });
}
function isMachO(path) {
  const buffer = Buffer.alloc(4);
  const descriptor = openSync(path, "r");
  try {
    if (readSync(descriptor, buffer, 0, 4, 0) !== 4) return false;
  } finally {
    closeSync(descriptor);
  }
  return new Set([
    "feedface",
    "cefaedfe",
    "feedfacf",
    "cffaedfe",
    "cafebabe",
    "bebafeca",
    "cafebabf",
    "bfbafeca",
  ]).has(buffer.toString("hex"));
}
function versionNumber(version) {
  assert.match(version, /^\d+\.\d+(?:\.\d+)?$/);
  return version
    .split(".")
    .reduce((value, part, index) => value + Number(part) * [1_000_000, 1_000, 1][index], 0);
}
function inventory(label) {
  const plist = command(label, "/usr/bin/hdiutil", ["info", "-plist"]);
  return JSON.parse(
    command(label + "-json", "/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: plist,
    }),
  );
}
function ownedAttachments(info, dmg, mount) {
  assert.ok(Array.isArray(info.images), "hdiutil must expose actual attachments");
  return info.images.flatMap((image) => {
    const ownedImage =
      typeof image["image-path"] === "string" && resolve(image["image-path"]) === dmg;
    const entities = image["system-entities"];
    if (!Array.isArray(entities)) {
      assert.equal(ownedImage, false, "Owned image has no device inventory");
      return [];
    }
    const ownedMount = entities.some(
      (entry) =>
        typeof entry["mount-point"] === "string" && resolve(entry["mount-point"]) === mount,
    );
    if (!ownedImage && !ownedMount) return [];
    const device = ownedImage
      ? entities.find((entry) => /^\/dev\/disk\d+$/.test(entry["dev-entry"] ?? ""))?.["dev-entry"]
      : undefined;
    const target = device ?? (ownedMount ? mount : undefined);
    assert.ok(target, "Owned attachment has no safe observed detach target");
    return [{ image: image["image-path"] ?? null, target, ownedImage, ownedMount }];
  });
}
async function inspectBundle(app, label, ownedRoot) {
  assert.ok(realpathSync(app).startsWith(realpathSync(ownedRoot) + "/"));
  const info = JSON.parse(
    command(`${label}-info`, "/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(app, "Contents/Info.plist"),
    ]),
  );
  const executable = join(app, "Contents/MacOS/Synara");
  const architectures = command(`${label}-arch`, "/usr/bin/lipo", ["-archs", executable])
    .trim()
    .split(/\s+/);
  const corePaths = [
    "Contents/Info.plist",
    "Contents/MacOS/Synara",
    "Contents/Resources/app.asar",
    "Contents/Resources/Assets.car",
    "Contents/Resources/icon.icns",
  ];
  const core = Object.fromEntries(
    await Promise.all(corePaths.map(async (path) => [path, await digest(join(app, path))])),
  );
  const runtimeHome = join(ownedRoot, `runtime-${label}`);
  mkdirSync(runtimeHome);
  const embedded = JSON.parse(
    command(
      `${label}-embedded-identity`,
      executable,
      [
        "-e",
        `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(app, "Contents/Resources/app.asar/package.json"))}, 'utf8'))`,
      ],
      {
        cwd: app,
        env: {
          PATH: process.env.PATH,
          HOME: runtimeHome,
          TMPDIR: runtimeHome,
          ELECTRON_RUN_AS_NODE: "1",
        },
      },
    ),
  );
  const binaries = [];
  for (const path of regularFiles(app).filter(isMachO)) {
    const output = command(`${label}-macho-${binaries.length}`, "/usr/bin/otool", [
      "-m",
      "-l",
      path,
    ]);
    const requirements = output
      .split(/Load command \d+/)
      .filter((block) => /cmd LC_(BUILD_VERSION|VERSION_MIN_MACOSX)/.test(block))
      .map((block) => ({
        command: /cmd (LC_[A-Z_]+)/.exec(block)?.[1],
        minimum: /\b(?:minos|version)\s+([\d.]+)/.exec(block)?.[1] ?? null,
        platform: /\bplatform\s+(\S+)/.exec(block)?.[1] ?? null,
      }));
    binaries.push({ path: relative(app, path), sha256: await digest(path), requirements });
  }
  const receipt = { info, architectures, embedded, core, binaries };
  save(`${label}-actual-bundle.json`, receipt);
  assert.equal(info.CFBundleIdentifier, "com.emanueledipietro.synara");
  assert.equal(info.CFBundleExecutable, "Synara");
  assert.equal(info.CFBundleShortVersionString, identity.version);
  assert.equal(info.LSMinimumSystemVersion, identity.minimum);
  assert.deepEqual(architectures, [arch === "x64" ? "x86_64" : "arm64"]);
  assert.equal(embedded.synaraCommitHash, identity.sha);
  assert.equal(embedded.synaraLockfileSha256, identity.lock);
  assert.equal(embedded.synaraDesktopFlavor, "production");
  assert.equal(embedded.version, identity.version);
  assert.equal(core["Contents/Resources/Assets.car"], (await iconReceipt()).sha256);
  const required = [
    `Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-${arch}/claude`,
    "Contents/Resources/cua-driver/cua-driver",
  ];
  for (const path of required) {
    const binary = binaries.find((entry) => entry.path === path);
    assert.ok(binary, `Required native executable absent: ${path}`);
    assert.ok(
      binary.requirements.some((entry) => entry.minimum === identity.minimum),
      `${path}: expected actual macOS 13 requirement`,
    );
  }
  assert.ok(binaries.some((entry) => entry.path === "Contents/MacOS/Synara"));
  for (const binary of binaries) {
    assert.ok(binary.requirements.length > 0, `No deployment target in ${binary.path}`);
    for (const requirement of binary.requirements) {
      assert.ok(
        versionNumber(requirement.minimum) <= versionNumber(identity.minimum),
        `${binary.path} exceeds declared minimum`,
      );
      if (requirement.command === "LC_BUILD_VERSION")
        assert.equal(requirement.platform, "1", binary.path);
    }
  }
  return receipt;
}
async function inspect() {
  const expected = [
    `Synara-${identity.version}-${arch}.dmg`,
    `Synara-${identity.version}-${arch}.zip`,
  ];
  const actualNames = readdirSync(packages)
    .filter((name) => /\.(dmg|zip)$/.test(name))
    .sort();
  assert.deepEqual(actualNames, [...expected].sort());
  const artifactReceipts = await Promise.all(
    expected.map(async (name) => ({
      name,
      bytes: statSync(join(packages, name)).size,
      sha256: await digest(join(packages, name)),
    })),
  );
  save("artifacts.json", artifactReceipts);
  assert.ok(artifactReceipts.every((entry) => entry.bytes > 0));
  const root = mkdtempSync(join(process.env.RUNNER_TEMP, "macos-minimum-owned-"));
  const expanded = join(root, "zip");
  const mount = join(root, "mount");
  mkdirSync(expanded);
  mkdirSync(mount);
  const dmg = resolve(packages, expected[0]);
  const zip = join(packages, expected[1]);
  let attachAttempted = false;
  let failure;
  let cleanupFailure;
  try {
    command("zip-extract", "/usr/bin/ditto", ["-x", "-k", zip, expanded], { timeout: 120_000 });
    assert.deepEqual(
      readdirSync(expanded).filter((name) => name.endsWith(".app")),
      ["Synara.app"],
    );
    const zipReceipt = await inspectBundle(join(expanded, "Synara.app"), "zip", root);
    command("dmg-verify", "/usr/bin/hdiutil", ["verify", dmg], { timeout: 180_000 });
    attachAttempted = true;
    command(
      "dmg-attach",
      "/usr/bin/hdiutil",
      ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, "-plist", dmg],
      { timeout: 90_000 },
    );
    assert.deepEqual(
      readdirSync(mount).filter((name) => name.endsWith(".app")),
      ["Synara.app"],
    );
    const dmgReceipt = await inspectBundle(join(mount, "Synara.app"), "dmg", root);
    assert.deepEqual(
      dmgReceipt.core,
      zipReceipt.core,
      "DMG and ZIP must carry identical core payloads",
    );
    assert.deepEqual(
      dmgReceipt.binaries,
      zipReceipt.binaries,
      "DMG and ZIP native inventory must match",
    );
    save("metadata-result.json", {
      success: true,
      source: identity,
      arch,
      compared: ["dmg", "zip"],
      minimum: identity.minimum,
      binaryCount: zipReceipt.binaries.length,
    });
  } catch (error) {
    failure = error;
  } finally {
    try {
      const observed = attachAttempted
        ? ownedAttachments(inventory("cleanup-before"), dmg, mount)
        : [];
      save("cleanup-observed.json", { attachAttempted, observed });
      for (let index = 0; index < observed.length; index++)
        command(`detach-${index}`, "/usr/bin/hdiutil", ["detach", observed[index].target], {
          timeout: 60_000,
        });
      const remaining = attachAttempted
        ? ownedAttachments(inventory("cleanup-after"), dmg, mount)
        : [];
      save("cleanup-result.json", {
        success: remaining.length === 0,
        attachAttempted,
        remaining,
        retainedOwnedFiles: root,
      });
      assert.equal(remaining.length, 0, "Owned image remains attached");
    } catch (error) {
      cleanupFailure = error;
    }
    save("inspection-outcome.json", {
      success: !failure && !cleanupFailure,
      failure: failure?.stack ?? null,
      cleanupFailure: cleanupFailure?.stack ?? null,
    });
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
}
let failure;
try {
  await sources();
  if (phase === "prepare") {
    appendFileSync(process.env.GITHUB_ENV, `MINIMUM_EVIDENCE=${evidence}\n`);
    save("provenance.json", {
      source: identity,
      arch,
      driverSha: process.env.GITHUB_SHA,
      run: process.env.GITHUB_RUN_ID,
      helperSha256: await digest(fileURLToPath(import.meta.url)),
      workflowSha256: await digest(
        join(driver, ".github/workflows/macos-minimum-qualification.yml"),
      ),
      icon: await iconReceipt(),
      qualification:
        "Exact-source unsigned production DMG and update ZIP. Actual native macOS 15 host for each architecture; metadata and embedded runtime identity inspection plus unchanged canonical packaged imports/startup. No signing, notarization, release publication, Homebrew audit success, GUI interaction or macOS 13 runtime claim. Signed v1.0.1 audit failure remains unchanged.",
    });
  } else if (phase === "inspect") {
    await inspect();
    await sources();
  } else {
    save(
      "workflow-outcomes.json",
      Object.fromEntries(
        ["PREPARE", "INSTALL", "BUILD", "METADATA", "PROVENANCE", "STARTUP"].map((name) => [
          name,
          process.env[`MINIMUM_${name}_OUTCOME`] ?? null,
        ]),
      ),
    );
    for (const name of ["PREPARE", "INSTALL", "BUILD", "METADATA", "PROVENANCE", "STARTUP"])
      assert.equal(process.env[`MINIMUM_${name}_OUTCOME`], "success", name);
    assert.equal(
      JSON.parse(readFileSync(join(evidence, "metadata-result.json"), "utf8")).success,
      true,
    );
    assert.equal(
      JSON.parse(readFileSync(join(evidence, "cleanup-result.json"), "utf8")).success,
      true,
    );
    const provenance = JSON.parse(
      readFileSync(join(evidence, `artifact-mac-${arch}.provenance.json`), "utf8"),
    );
    assert.equal(provenance.publication, false);
    assert.equal(provenance.signing.status, "unsigned-build-only");
    assert.equal(provenance.platform, "mac");
    assert.equal(provenance.arch, arch);
    assert.equal(provenance.version, identity.version);
    assert.deepEqual(provenance.source, {
      commit: identity.sha,
      tag: null,
      lockfileSha256: identity.lock,
    });
    const artifacts = JSON.parse(readFileSync(join(evidence, "artifacts.json"), "utf8"));
    for (const artifact of artifacts) {
      const recorded = provenance.artifacts.find((entry) => entry.fileName === artifact.name);
      assert.deepEqual(recorded, {
        fileName: artifact.name,
        size: artifact.bytes,
        sha256: artifact.sha256,
      });
      assert.equal(await digest(join(packages, artifact.name)), artifact.sha256);
    }
    const startup = readFileSync(join(evidence, "canonical-startup.log"), "utf8");
    assert.ok(startup.includes("Packaged runtime dependency smoke passed from isolated state."));
    assert.ok(startup.includes(`Packaged mac/${arch} startup smoke passed from isolated state.`));
  }
} catch (error) {
  failure = error;
  save(`${phase}-failure.json`, { message: error.message, stack: error.stack });
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  if (phase === "verify") {
    const files = await Promise.all(
      regularFiles(evidence)
        .filter((path) => !path.endsWith("/qualification.json"))
        .map(async (path) => ({
          path: relative(evidence, path),
          bytes: statSync(path).size,
          sha256: await digest(path),
        })),
    );
    save("qualification.json", {
      success: !failure,
      source: identity,
      arch,
      driverSha: process.env.GITHUB_SHA,
      run: process.env.GITHUB_RUN_ID,
      files,
    });
  }
}

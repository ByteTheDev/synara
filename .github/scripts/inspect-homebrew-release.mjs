// Read actual published DMGs without installing or launching the application.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const assets = {
  arm64: {
    id: 623170563,
    bytes: 299369491,
    sha256: "d2e63ec2ff7da36de3531ca95ef8ac2b4161631fee9f94e3da15b31ff393d3ea",
  },
  x64: {
    id: 623170557,
    bytes: 308822463,
    sha256: "c6ce67a500e92c3f26fb885fbf1be2c901aa401f71ff13a8b0bb9a1104df3ddb",
  },
};
const arch = process.env.RELEASE_ARCH;
assert.ok(Object.hasOwn(assets, arch));
assert.equal(process.platform, "darwin");
const asset = assets[arch];
const evidence = join(process.env.RUNNER_TEMP, `homebrew-release-${arch}`);
mkdirSync(evidence, { recursive: true });
const owned = mkdtempSync(join(process.env.RUNNER_TEMP, `homebrew-dmg-${arch}-`));
const mount = join(owned, "mount");
mkdirSync(mount);
const fileName = `Synara-1.0.1-${arch}.dmg`;
const dmg = join(owned, fileName);
const save = (name, value) =>
  writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + "\n");
function command(label, program, args, { timeout = 30_000, required = true, input } = {}) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    timeout,
    shell: false,
    maxBuffer: 32 * 1024 * 1024,
    input,
  });
  writeFileSync(join(evidence, label + ".log"), (result.stdout ?? "") + (result.stderr ?? ""));
  const outcome = {
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
  };
  save(label + ".json", outcome);
  if (required) {
    assert.equal(outcome.error, null, outcome.error);
    assert.equal(outcome.status, 0, `${label}: ${result.stderr}`);
  }
  return { ...outcome, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function sourceIntegrity() {
  assert.equal(
    command("driver-head", "git", ["rev-parse", "HEAD"]).stdout.trim(),
    process.env.GITHUB_SHA,
  );
  assert.equal(
    command("driver-clean", "git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]).stdout.trim(),
    "",
  );
}
function plist(path, label) {
  return JSON.parse(
    command(label, "/usr/bin/plutil", ["-convert", "json", "-o", "-", path]).stdout,
  );
}
function regularFiles(directory) {
  const result = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isDirectory()) result.push(...regularFiles(path));
    else if (stat.isFile()) result.push(path);
  }
  return result;
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
function ownedAttachments(info) {
  assert.ok(Array.isArray(info.images), "hdiutil info did not expose an image inventory");
  return info.images.flatMap((image) => {
    const ownedImage =
      typeof image["image-path"] === "string" && resolve(image["image-path"]) === resolve(dmg);
    const entities = image["system-entities"];
    if (!Array.isArray(entities)) {
      assert.equal(ownedImage, false, "Owned image has no device inventory; cleanup is unproven");
      return [];
    }
    const ownedMount = entities.some(
      (entity) =>
        typeof entity["mount-point"] === "string" &&
        resolve(entity["mount-point"]) === resolve(mount),
    );
    if (!ownedImage && !ownedMount) return [];
    const device = ownedImage
      ? entities.find((entity) => /^\/dev\/disk\d+$/.test(entity["dev-entry"] ?? ""))?.["dev-entry"]
      : undefined;
    const target = device ?? (ownedMount ? mount : undefined);
    assert.ok(target, "Owned image has no observed whole device or owned mount to detach");
    return [{ image: image["image-path"] ?? null, target, ownedImage, ownedMount }];
  });
}
function imageInventory(label) {
  const info = command(label, "/usr/bin/hdiutil", ["info", "-plist"]);
  return JSON.parse(
    command(label + "-json", "/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: info.stdout,
    }).stdout,
  );
}
let attached = false;
let attachAttempted = false;
let failure;
try {
  sourceIntegrity();
  save("provenance.json", {
    releaseId: 407310598,
    tag: "v1.0.1",
    releaseTargetCommitish: "f44ce959bdeedf5e2dfe117d362ef4e08386b3c3",
    arch,
    asset,
    fileName,
    driverSha: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    helperSha256: await digest(fileURLToPath(import.meta.url)),
    qualification:
      "Published vendor artifact read-only inspection. No application install, launch, provider session, cask submission or upstream acceptance claim.",
  });
  const url = `https://github.com/Emanuele-web04/synara/releases/download/v1.0.1/${fileName}`;
  command(
    "download",
    "/usr/bin/curl",
    [
      "--fail",
      "--location",
      "--show-error",
      "--silent",
      "--connect-timeout",
      "20",
      "--max-time",
      "600",
      "--max-filesize",
      String(asset.bytes),
      "--output",
      dmg,
      url,
    ],
    { timeout: 610_000 },
  );
  const actual = { bytes: statSync(dmg).size, sha256: await digest(dmg) };
  save("dmg-integrity.json", { expected: asset, actual });
  assert.equal(actual.bytes, asset.bytes);
  assert.equal(actual.sha256, asset.sha256);
  command("dmg-verify", "/usr/bin/hdiutil", ["verify", dmg], { timeout: 180_000 });
  attachAttempted = true;
  command(
    "attach-readonly",
    "/usr/bin/hdiutil",
    ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, "-plist", dmg],
    { timeout: 90_000 },
  );
  attached = true;
  const app = join(mount, "Synara.app");
  assert.ok(lstatSync(app).isDirectory());
  const info = plist(join(app, "Contents/Info.plist"), "application-info");
  assert.equal(info.CFBundleIdentifier, "com.emanueledipietro.synara");
  assert.equal(info.CFBundleExecutable, "Synara");
  assert.equal(info.CFBundleShortVersionString, "1.0.1");
  const mainExecutable = join(app, "Contents/MacOS/Synara");
  const mainArchitectures = command("main-architectures", "/usr/bin/lipo", [
    "-archs",
    mainExecutable,
  ])
    .stdout.trim()
    .split(/\s+/);
  assert.ok(mainArchitectures.includes(arch === "x64" ? "x86_64" : "arm64"));
  const frameworkInfo = join(
    app,
    "Contents/Frameworks/Electron Framework.framework/Resources/Info.plist",
  );
  assert.ok(realpathSync(frameworkInfo).startsWith(realpathSync(app) + "/"));
  const electron = plist(frameworkInfo, "electron-framework-info");
  const binaryMetadata = [];
  for (const path of regularFiles(app).filter(isMachO)) {
    const name = relative(app, path);
    const number = binaryMetadata.length;
    // Apple's -m disables archive(member) parsing for names such as Synara Helper (GPU).
    const output = command(`macho-${number}`, "/usr/bin/otool", ["-m", "-l", path]).stdout;
    const requirements = output
      .split(/Load command \d+/)
      .filter((block) => /cmd LC_(BUILD_VERSION|VERSION_MIN_MACOSX)/.test(block))
      .map((block) => ({
        command: /cmd (LC_[A-Z_]+)/.exec(block)?.[1],
        minimum: /\b(?:minos|version)\s+([\d.]+)/.exec(block)?.[1] ?? null,
        platform: /\bplatform\s+(\S+)/.exec(block)?.[1] ?? null,
      }));
    binaryMetadata.push({ path: name, sha256: await digest(path), requirements });
  }
  assert.ok(binaryMetadata.some((entry) => entry.path === "Contents/MacOS/Synara"));
  save("actual-bundle-metadata.json", {
    application: info,
    electronFramework: electron,
    mainArchitectures,
    binaries: binaryMetadata,
  });
  const signature = command("codesign-details", "/usr/bin/codesign", ["-d", "--verbose=4", app], {
    required: false,
  });
  const verify = command(
    "codesign-verify",
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", app],
    { timeout: 120_000, required: false },
  );
  const gatekeeper = command(
    "gatekeeper-assess",
    "/usr/sbin/spctl",
    ["--assess", "--type", "execute", "--verbose=4", app],
    { timeout: 120_000, required: false },
  );
  const staple = command("dmg-staple", "/usr/bin/xcrun", ["stapler", "validate", dmg], {
    timeout: 90_000,
    required: false,
  });
  save("signing-observations.json", { signature, verify, gatekeeper, staple });
  for (const [name, result] of Object.entries({ signature, verify, gatekeeper, staple })) {
    assert.equal(result.error, null, name);
    assert.equal(result.status, 0, `${name} failed; raw status and logs preserved`);
  }
  sourceIntegrity();
} catch (error) {
  failure = error;
  save("original-inspection-failure.json", { message: String(error), stack: error.stack });
} finally {
  const cleanup = {
    attachAttempted,
    attachCommandSucceeded: attached,
    observed: [],
    detaches: [],
    remaining: null,
    error: null,
    ownedRoot: owned,
  };
  if (attachAttempted) {
    try {
      cleanup.observed = ownedAttachments(imageInventory("cleanup-image-inventory"));
      for (const [index, target] of [
        ...new Set(cleanup.observed.map((image) => image.target)),
      ].entries()) {
        const result = command(`detach-owned-${index}`, "/usr/bin/hdiutil", ["detach", target], {
          timeout: 60_000,
          required: false,
        });
        cleanup.detaches.push({
          target,
          status: result.status,
          signal: result.signal,
          error: result.error,
        });
      }
      cleanup.remaining = ownedAttachments(imageInventory("cleanup-final-inventory"));
      assert.equal(cleanup.remaining.length, 0, "Owned image attachment remains");
      for (const result of cleanup.detaches) {
        assert.equal(result.error, null);
        assert.equal(result.status, 0);
      }
    } catch (error) {
      cleanup.error = String(error);
      failure ??= error;
    }
  }
  save("cleanup.json", cleanup);
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
} else {
  const files = await Promise.all(
    readdirSync(evidence)
      .filter((name) => statSync(join(evidence, name)).isFile())
      .map(async (name) => ({
        name,
        bytes: statSync(join(evidence, name)).size,
        sha256: await digest(join(evidence, name)),
      })),
  );
  save("qualification.json", {
    passed: true,
    arch,
    release: "v1.0.1",
    releaseTargetCommitish: "f44ce959bdeedf5e2dfe117d362ef4e08386b3c3",
    driver: process.env.GITHUB_SHA,
    files,
    qualification:
      "Read-only metadata and signing observations only; no minimum-OS execution or Homebrew upstream acceptance claim.",
  });
}

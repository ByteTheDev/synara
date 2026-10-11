// Actual disposable local-tap qualification. No upstream tap, release or app launch.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { release } from "node:os";
import { fileURLToPath } from "node:url";

const sourceSha = "6d3682aa9123d02b560131ae363e0b627e634447";
const sourceTree = "d6898a297b37af10ff79502796f3f207db3667e7";
const caskRelative = "packaging/homebrew/Casks/synara.rb";
const caskSha256 = "124d98ad443bb216cf6e69bbe64049dfe22ea837ff857f0fe0e4eec5ad1c128a";
const lockSha256 = "6d7d0c78443129580cf1ef3fbfa9dee9784e1dec4ea9087f1c7e912bce6d463e";
const assets = {
  arm64: {
    id: 623170563,
    bytes: 299369491,
    sha256: "d2e63ec2ff7da36de3531ca95ef8ac2b4161631fee9f94e3da15b31ff393d3ea",
    machArch: "arm64",
  },
  x64: {
    id: 623170557,
    bytes: 308822463,
    sha256: "c6ce67a500e92c3f26fb885fbf1be2c901aa401f71ff13a8b0bb9a1104df3ddb",
    machArch: "x86_64",
  },
};
assert.equal(process.platform, "darwin");
assert.ok(Object.hasOwn(assets, process.arch));
assert.equal(process.env.HOMEBREW_EXPECTED_ARCH, process.arch);
assert.match(process.env.GITHUB_RUN_ID ?? "", /^\d+$/);
assert.match(process.env.GITHUB_SHA ?? "", /^[0-9a-f]{40}$/);
const asset = assets[process.arch];
const source = process.cwd();
const driver = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(process.env.RUNNER_TEMP, "homebrew-cask-evidence");
mkdirSync(evidence, { recursive: true });
const owned = mkdtempSync(join(process.env.RUNNER_TEMP, "homebrew-1198-owned-"));
const appdir = join(owned, "applications");
const app = join(appdir, "Synara.app");
const cache = join(owned, "cache");
mkdirSync(appdir);
mkdirSync(cache);
const tap = `local/synara1198-${process.env.GITHUB_RUN_ID}-${process.arch}`;
const token = `${tap}/synara`;
const save = (name, value) =>
  writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + "\n");
const env = {
  ...Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "USER", "LOGNAME", "LANG", "LC_ALL", "TERM"]
      .filter((key) => typeof process.env[key] === "string")
      .map((key) => [key, process.env[key]]),
  ),
  CI: "1",
  HOMEBREW_NO_AUTO_UPDATE: "1",
  HOMEBREW_NO_ANALYTICS: "1",
  HOMEBREW_NO_INSTALL_CLEANUP: "1",
  HOMEBREW_CACHE: cache,
};
const commands = [];
function observe(name, command, args, timeout = 60_000, cwd = source) {
  const started = new Date().toISOString();
  const result = spawnSync(command, args, {
    cwd,
    env,
    shell: false,
    encoding: "utf8",
    timeout,
    killSignal: "SIGKILL",
    maxBuffer: 16 * 1024 * 1024,
  });
  const observation = {
    name,
    command,
    args,
    cwd,
    started,
    finished: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
    error: result.error?.message ?? null,
  };
  writeFileSync(join(evidence, name + ".stdout.log"), result.stdout ?? "");
  writeFileSync(join(evidence, name + ".stderr.log"), result.stderr ?? "");
  save(name + ".json", observation);
  commands.push(observation);
  return { ...observation, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function required(name, command, args, timeout, cwd) {
  const result = observe(name, command, args, timeout, cwd);
  assert.equal(result.error, null, `${name}: ${result.error}`);
  assert.equal(result.status, 0, `${name}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function sourceGuard(phase) {
  assert.equal(required(phase + "-source-head", "git", ["rev-parse", "HEAD"]), sourceSha);
  assert.equal(required(phase + "-source-tree", "git", ["rev-parse", "HEAD^{tree}"]), sourceTree);
  assert.equal(required(phase + "-source-diff", "git", ["diff", "--exit-code", "HEAD", "--"]), "");
  assert.equal(await digest(join(source, caskRelative)), caskSha256);
  assert.equal(await digest(join(source, "bun.lock")), lockSha256);
  assert.equal(
    required(phase + "-driver-head", "git", ["rev-parse", "HEAD"], 60_000, driver),
    process.env.GITHUB_SHA,
  );
  assert.equal(
    required(
      phase + "-driver-status",
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      60_000,
      driver,
    ),
    "",
  );
}
const runningScript = `
ObjC.import('AppKit');
function run() {
  var matches = [];
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    if (ObjC.unwrap(app.bundleIdentifier) === 'com.emanueledipietro.synara') {
      matches.push({ pid: Number(app.processIdentifier), path: ObjC.unwrap(app.bundleURL.path) });
    }
  }
  return JSON.stringify(matches);
}
`;
function requireNoRunningSynara(phase) {
  const observed = JSON.parse(
    required(phase + "-running-apps", "/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      runningScript,
    ]),
  );
  assert.deepEqual(observed, [], "Refuse a bundle-ID quit while any Synara application is running");
}
function installedCasks(phase) {
  return required(phase + "-installed-casks", "brew", ["list", "--cask"])
    .split(/\r?\n/)
    .filter(Boolean);
}
function containsSynara(names) {
  return names.some((name) => name.split("/").at(-1) === "synara");
}
let expectedTapPath;
let tapAttempted = false;
let installAttempted = false;
let failure;
let style;
let audit;
let lifecyclePassed = false;
const cleanup = { attempted: false, failures: [] };
try {
  await sourceGuard("before");
  const brewVersion = required("brew-version", "brew", ["--version"]);
  const brewRepository = realpathSync(required("brew-repository", "brew", ["--repository"]));
  assert.ok(isAbsolute(brewRepository));
  expectedTapPath = join(brewRepository, "Library/Taps/local", "homebrew-" + tap.split("/")[1]);
  assert.ok(!existsSync(expectedTapPath), "Refuse an existing local tap");
  assert.ok(!containsSynara(installedCasks("before")), "Refuse a pre-existing Synara cask");
  for (const existing of [
    "/Applications/Synara.app",
    join(process.env.HOME, "Applications/Synara.app"),
  ])
    assert.ok(!existsSync(existing), `Refuse a pre-existing application: ${existing}`);
  requireNoRunningSynara("before");
  save("provenance.json", {
    sourceSha,
    sourceTree,
    driverSha: process.env.GITHUB_SHA,
    driverTree: required("driver-tree", "git", ["rev-parse", "HEAD^{tree}"], 60_000, driver),
    caskSha256,
    lockSha256,
    brewVersion,
    brewRepository,
    tap,
    token,
    releaseId: 407310598,
    version: "1.0.1",
    asset,
    sourceFileSha256: await digest(fileURLToPath(import.meta.url)),
    workflowSha256: await digest(join(driver, ".github/workflows/homebrew-cask-qualification.yml")),
    os: { platform: process.platform, arch: process.arch, release: release() },
    run: process.env.GITHUB_RUN_ID,
    qualification:
      "Actual current hosted Homebrew with auto-update disabled and exact version recorded; unchanged candidate Ruby bytes in a unique local tap, actual checksum-required quarantined installation and normal removal. No app launch, oldest-macOS runtime, zap, upgrade, upstream cask acceptance, source dependency install, release or tag publication claim.",
  });
  tapAttempted = true;
  save("admission.json", { tapAttempted, installAttempted, expectedTapPath, appdir, token });
  required("tap-new", "brew", ["tap-new", "--no-git", tap], 180_000);
  const actualTapPath = realpathSync(required("tap-repository", "brew", ["--repository", tap]));
  assert.equal(actualTapPath, expectedTapPath);
  assert.ok(lstatSync(actualTapPath).isDirectory() && !lstatSync(actualTapPath).isSymbolicLink());
  mkdirSync(join(actualTapPath, "Casks"), { recursive: true });
  const localCask = join(actualTapPath, "Casks/synara.rb");
  assert.ok(!existsSync(localCask));
  copyFileSync(join(source, caskRelative), localCask);
  assert.equal(await digest(localCask), caskSha256);
  style = observe("brew-style", "brew", ["style", localCask], 600_000);
  audit = observe(
    "brew-audit",
    "brew",
    ["audit", "--cask", "--strict", "--online", token],
    600_000,
  );
  assert.equal(await digest(localCask), caskSha256, "Auditing changed the cask");
  const info = JSON.parse(required("cask-info", "brew", ["info", "--cask", "--json=v2", token]));
  assert.equal(info.casks.length, 1);
  const cask = info.casks[0];
  assert.equal(cask.token, "synara");
  assert.equal(cask.tap, tap);
  assert.equal(cask.version, "1.0.1");
  assert.equal(cask.sha256, asset.sha256);
  assert.equal(
    cask.url,
    `https://github.com/Emanuele-web04/synara/releases/download/v1.0.1/Synara-1.0.1-${process.arch}.dmg`,
  );
  installAttempted = true;
  save("admission.json", { tapAttempted, installAttempted, expectedTapPath, appdir, token });
  required(
    "brew-install",
    "brew",
    ["install", "--cask", "--require-sha", "--appdir", appdir, token],
    600_000,
  );
  assert.ok(lstatSync(app).isDirectory() && !lstatSync(app).isSymbolicLink());
  assert.equal(realpathSync(app), app);
  const plist = JSON.parse(
    required("installed-plist", "/usr/bin/plutil", [
      "-convert",
      "json",
      "-o",
      "-",
      join(app, "Contents/Info.plist"),
    ]),
  );
  assert.equal(plist.CFBundleIdentifier, "com.emanueledipietro.synara");
  assert.equal(plist.CFBundleShortVersionString, "1.0.1");
  const executable = join(app, "Contents/MacOS/Synara");
  assert.equal(
    required("installed-architecture", "/usr/bin/lipo", ["-archs", executable]),
    asset.machArch,
  );
  required(
    "installed-codesign",
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", app],
    120_000,
  );
  required(
    "installed-gatekeeper",
    "/usr/sbin/spctl",
    ["--assess", "--type", "execute", "--verbose=4", app],
    120_000,
  );
  required("installed-notarization", "/usr/bin/xcrun", ["stapler", "validate", app], 120_000);
  const downloaded = realpathSync(
    required("cask-cache-path", "brew", ["--cache", "--cask", token]),
  );
  assert.ok(
    !relative(cache, downloaded).startsWith("..") && !isAbsolute(relative(cache, downloaded)),
  );
  assert.ok(statSync(downloaded).isFile());
  assert.equal(statSync(downloaded).size, asset.bytes);
  assert.equal(await digest(downloaded), asset.sha256);
  assert.ok(containsSynara(installedCasks("after-install")));
  save("installation.json", {
    passed: true,
    token,
    app,
    plist,
    sourceCaskSha256: caskSha256,
    downloaded: {
      bytes: statSync(downloaded).size,
      sha256: await digest(downloaded),
      releaseAssetId: asset.id,
    },
    executableSha256: await digest(executable),
    asarSha256: await digest(join(app, "Contents/Resources/app.asar")),
    appLaunchPerformed: false,
  });
  requireNoRunningSynara("before-remove");
  required("brew-uninstall", "brew", ["uninstall", "--cask", token], 180_000);
  assert.ok(!existsSync(app));
  assert.ok(!containsSynara(installedCasks("after-remove")));
  save("removal.json", { passed: true, appAbsent: true, caskAbsent: true, zapPerformed: false });
  lifecyclePassed = true;
} catch (error) {
  failure = error;
  save("original-failure.json", { message: String(error), stack: error.stack });
} finally {
  cleanup.attempted = tapAttempted || installAttempted;
  if (installAttempted) {
    try {
      const installed = containsSynara(installedCasks("cleanup-before"));
      if (installed || existsSync(app)) {
        requireNoRunningSynara("cleanup");
        required("cleanup-uninstall", "brew", ["uninstall", "--cask", token], 180_000);
      }
      assert.ok(!existsSync(app));
      assert.ok(!containsSynara(installedCasks("cleanup-after")));
      cleanup.appAbsent = true;
      cleanup.caskAbsent = true;
    } catch (error) {
      cleanup.failures.push({ action: "owned-cask-removal", message: String(error) });
    }
  }
  if (tapAttempted) {
    try {
      if (existsSync(expectedTapPath)) {
        assert.equal(realpathSync(expectedTapPath), expectedTapPath);
        required("cleanup-untap", "brew", ["untap", tap], 120_000);
      }
      assert.ok(!existsSync(expectedTapPath));
      cleanup.tapAbsent = true;
    } catch (error) {
      cleanup.failures.push({ action: "owned-tap-removal", message: String(error) });
    }
  }
  save("cleanup.json", cleanup);
  try {
    await sourceGuard("after");
    assert.equal(cleanup.failures.length, 0, "Owned-state cleanup failed");
    assert.ok(lifecyclePassed, "Native installation/removal did not pass");
    assert.equal(style?.status, 0, "Actual brew style failed; raw result retained");
    assert.equal(style?.error, null);
    assert.equal(audit?.status, 0, "Actual brew audit failed; raw result retained");
    assert.equal(audit?.error, null);
  } catch (error) {
    failure ??= error;
    save("qualification-failure.json", { message: String(error), stack: error.stack });
  }
  const files = await Promise.all(
    readdirSync(evidence).map(async (name) => ({
      name,
      bytes: statSync(join(evidence, name)).size,
      sha256: await digest(join(evidence, name)),
    })),
  );
  save("qualification.json", {
    passed: !failure,
    sourceSha,
    sourceTree,
    driverSha: process.env.GITHUB_SHA,
    lifecyclePassed,
    styleStatus: style?.status ?? null,
    auditStatus: audit?.status ?? null,
    cleanup,
    commands,
    files,
    scope:
      "Actual local-tap audit and checksum-required install/removal only; no upstream acceptance, app launch, zap, upgrade or oldest-OS execution.",
  });
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}

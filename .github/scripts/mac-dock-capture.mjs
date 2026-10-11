// Exact-source package and real Dock evidence. Never change application source.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { release } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceSha = "ec8c940e07582454a475250ade40147e3c89d59f";
const sourceTree = "26c3b060469f224dce8135d8046697eb43fe0794";
const authorSha = "01ca9a62f8bb222dda23d8c68181acdbf5ddd1fb";
const source = process.cwd();
const driver = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const author = resolve(source, "../author");
const evidence = join(process.env.RUNNER_TEMP, "mac-dock-evidence");
const statePath = join(process.env.RUNNER_TEMP, "mac-dock-state.json");
const assets = join(process.env.RUNNER_TEMP, "mac-dock-packages");
const phase = process.argv[2];
assert.ok(["prepare", "capture", "cleanup", "verify"].includes(phase));
assert.equal(process.platform, "darwin");
assert.equal(process.arch, "arm64");
mkdirSync(evidence, { recursive: true });
const save = (name, value) =>
  writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + "\n");
async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
function run(command, args, { cwd = source, env = process.env, timeout = 30_000, log } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
    shell: false,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (log) {
    writeFileSync(join(evidence, log), (result.stdout ?? "") + (result.stderr ?? ""));
    save(log + ".json", {
      command,
      args,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
    });
  }
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function assertSources() {
  for (const [cwd, expected] of [
    [source, sourceSha],
    [author, authorSha],
    [driver, process.env.GITHUB_SHA],
  ]) {
    assert.equal(run("git", ["rev-parse", "HEAD"], { cwd }), expected);
    assert.equal(run("git", ["diff", "--exit-code", "HEAD", "--"], { cwd }), "");
  }
  assert.equal(run("git", ["rev-parse", "HEAD^{tree}"]), sourceTree);
}
async function verifyIconCatalog() {
  const catalog = join(process.env.RUNNER_TEMP, "mac-dock-icon", "Assets.car");
  assert.equal(process.env.SYNARA_MAC_ICON_CATALOG, catalog);
  assert.equal(readFileSync(join(dirname(catalog), "source-commit.txt"), "utf8").trim(), sourceSha);
  const expected = readFileSync(join(dirname(catalog), "Assets.car.sha256"), "utf8").trim();
  assert.match(expected, /^[0-9a-f]{64} [ *]Assets\.car$/);
  const sha256 = await digest(catalog);
  assert.equal(sha256, expected.slice(0, 64));
  assert.ok(statSync(catalog).size > 0);
  return { sourceSha, sha256, bytes: statSync(catalog).size };
}
const state = () => JSON.parse(readFileSync(statePath, "utf8"));
function native(mode, setup) {
  return run(setup.helper, [mode, setup.configurationPath], {
    timeout: 180_000,
    log: `native-${mode}.log`,
  });
}
async function bounded(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${description} deadline`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function captureWithActualQuitConfirmation(setup) {
  const configuration = JSON.parse(readFileSync(setup.configurationPath, "utf8"));
  const profile = join(configuration.environment.HOME, "Library", "Application Support", "synara");
  assert.ok(profile.startsWith(setup.ownedRoot + "/"));
  const portFile = join(profile, "DevToolsActivePort");
  assert.ok(!existsSync(portFile), "Debugger endpoint must come from this new owned launch");
  const requireWeb = createRequire(join(source, "apps/web/package.json"));
  assert.equal(requireWeb("playwright/package.json").version, "1.62.1");
  const playwright = requireWeb("playwright");
  const descriptor = openSync(join(evidence, "native-capture.log"), "w");
  let child;
  try {
    child = spawn(setup.helper, ["capture", setup.configurationPath], {
      cwd: source,
      shell: false,
      stdio: ["ignore", descriptor, descriptor],
    });
  } finally {
    closeSync(descriptor);
  }
  const observation = {
    actualExit: null,
    spawnError: null,
    processErrors: [],
    ownedHandleStop: null,
    stopDeadline: false,
    directFileLog: true,
  };
  let spawned = false;
  const settled = new Promise((resolveExit) => {
    child.once("spawn", () => {
      spawned = true;
    });
    child.once("exit", (code, signal) => {
      observation.actualExit = { code, signal };
      resolveExit(observation.actualExit);
    });
    child.on("error", (error) => {
      observation.processErrors.push(String(error));
      if (!spawned) {
        observation.spawnError = String(error);
        resolveExit({ code: null, signal: null, error: String(error) });
      }
    });
  });
  async function until(predicate, milliseconds, description) {
    const end = Date.now() + milliseconds;
    while (Date.now() < end) {
      const value = predicate();
      if (value) return value;
      assert.equal(observation.spawnError, null, observation.spawnError);
      assert.equal(observation.actualExit, null, `Native observer exited before ${description}`);
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    throw new Error(`${description} deadline`);
  }
  let browser;
  try {
    const lines = await until(
      () => {
        if (!existsSync(portFile)) return false;
        const lines = readFileSync(portFile, "utf8").trim().split(/\r?\n/);
        return lines.length === 2 ? lines : false;
      },
      120_000,
      "Owned Chromium endpoint",
    );
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{1,5}$/);
    const port = Number(lines[0]);
    assert.ok(port > 0 && port <= 65535);
    assert.match(lines[1], /^\/devtools\/browser\/[a-zA-Z0-9-]+$/);
    browser = await playwright.chromium.connectOverCDP(`ws://127.0.0.1:${port}${lines[1]}`, {
      timeout: 30_000,
      noDefaults: true,
    });
    const pages = () =>
      browser
        .contexts()
        .flatMap((context) => context.pages())
        .filter((page) => {
          try {
            const url = new URL(page.url());
            return url.protocol === "synara:" && url.hostname === "app";
          } catch {
            return false;
          }
        });
    await until(() => pages().length === 1, 30_000, "Actual owned renderer");
    const page = pages()[0];
    await until(
      () => existsSync(join(evidence, "normal-quit-request.json")),
      120_000,
      "Normal native quit request",
    );
    const request = JSON.parse(readFileSync(join(evidence, "normal-quit-request.json"), "utf8"));
    const startup = JSON.parse(readFileSync(join(evidence, "application-startup.json"), "utf8"));
    assert.equal(request.pid, startup.pid);
    assert.equal(request.appPath, setup.appPath);
    await page
      .getByText("Are you sure you want to quit?", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    const quit = page.getByRole("button", { name: "Quit", exact: true });
    await quit.waitFor({ state: "visible", timeout: 10_000 });
    const renderer = {
      profile,
      endpoint: "Owned ephemeral loopback Chromium endpoint",
      protocol: "synara:",
      host: "app",
      nativePid: request.pid,
      visiblePrompt: true,
      visibleButton: true,
      clicked: false,
    };
    save("renderer-confirmation.json", renderer);
    run(
      "/usr/sbin/screencapture",
      ["-x", "-t", "png", "-T", "1", join(evidence, "quit-confirmation.png")],
      { timeout: 15_000, log: "quit-confirmation-screen.log" },
    );
    await quit.click({ timeout: 10_000 });
    renderer.clicked = true;
    save("renderer-confirmation.json", renderer);
    const result = await bounded(
      settled,
      60_000,
      "Actual native normal quit and closed screenshot",
    );
    assert.equal(result.code, 0, JSON.stringify(result));
    assert.deepEqual(observation.processErrors, []);
  } catch (error) {
    save("renderer-confirmation-failure.json", { message: String(error), stack: error.stack });
    throw error;
  } finally {
    if (!observation.actualExit && !observation.spawnError) {
      // Stop only the owned helper handle; app termination remains the separate
      // exact-bundle native cleanup below, with any forced stop recorded.
      try {
        observation.ownedHandleStop = child.kill("SIGTERM");
      } catch (error) {
        observation.processErrors.push(String(error));
      }
      try {
        await bounded(settled, 5_000, "Owned observer stop");
      } catch {
        observation.stopDeadline = true;
      }
    }
    save("native-capture.log.json", observation);
    if (browser) {
      try {
        await bounded(browser.close(), 10_000, "Owned Chromium observer disconnect");
      } catch (error) {
        save("renderer-disconnect-failure.json", { message: String(error) });
        throw error;
      }
    }
  }
}
const corePaths = [
  "Contents/MacOS/Synara",
  "Contents/Resources/app.asar",
  "Contents/Resources/icon.icns",
  "Contents/Resources/Assets.car",
];
async function coreHashes(appPath) {
  return Object.fromEntries(
    await Promise.all(corePaths.map(async (path) => [path, await digest(join(appPath, path))])),
  );
}
async function main() {
  // Cleanup must still run if an earlier source-integrity assertion failed.
  if (phase !== "cleanup") {
    assertSources();
    save("compiled-icon-receipt.json", await verifyIconCatalog());
  }
  if (phase === "prepare") {
    assert.equal(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.ok(!existsSync(statePath), "Refuse to overwrite an existing experiment");
    const ownedRoot = mkdtempSync(join(process.env.RUNNER_TEMP, "mac-dock-owned-"));
    const version = JSON.parse(
      readFileSync(join(source, "apps/server/package.json"), "utf8"),
    ).version;
    const canonical = await import(
      pathToFileURL(join(source, "scripts/verify-packaged-desktop-startup.ts")).href
    );
    const fullEnvironment = canonical.createPackagedDesktopSmokeEnvironment(
      join(ownedRoot, "state"),
      { platform: "mac", version, executableName: "synara" },
    );
    const allowed = [
      "PATH",
      "LANG",
      "LC_ALL",
      "TMPDIR",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "SYNARA_HOME",
      "SYNARA_BETA_HOME",
      "SYNARA_DISABLE_AUTO_UPDATE",
      "ELECTRON_ENABLE_LOGGING",
    ];
    const environment = Object.fromEntries(
      allowed
        .filter((key) => typeof fullEnvironment[key] === "string")
        .map((key) => [key, fullEnvironment[key]]),
    );
    const configuration = {
      evidence,
      ownedRoot,
      appPath: join(ownedRoot, "expanded", "Synara.app"),
      environment,
      startupLog: join(environment.SYNARA_HOME, "userdata", "logs", "desktop-main.log"),
    };
    const setup = {
      ownedRoot,
      version,
      helper: join(ownedRoot, "mac-dock-lifecycle"),
      configurationPath: join(ownedRoot, "capture-configuration.json"),
      appPath: configuration.appPath,
    };
    writeFileSync(setup.configurationPath, JSON.stringify(configuration, null, 2) + "\n");
    writeFileSync(statePath, JSON.stringify(setup, null, 2) + "\n");
    save("provenance.json", {
      sourceSha,
      sourceTree,
      authorSha,
      driverSha: process.env.GITHUB_SHA,
      driverTree: run("git", ["rev-parse", "HEAD^{tree}"], { cwd: driver }),
      version,
      run: process.env.GITHUB_RUN_ID,
      os: { platform: process.platform, arch: process.arch, release: release() },
      lockfileSha256: await digest(join(source, "bun.lock")),
      mainSha256: await digest(join(source, "apps/desktop/src/main.ts")),
      canonicalStartupSha256: await digest(
        join(source, "scripts/verify-packaged-desktop-startup.ts"),
      ),
      driverScriptSha256: await digest(fileURLToPath(import.meta.url)),
      nativeScriptSha256: await digest(join(driver, ".github/scripts/mac-dock-lifecycle.swift")),
      workflowSha256: await digest(join(driver, ".github/workflows/mac-dock-capture.yml")),
      compiledIcon: await verifyIconCatalog(),
      qualification:
        "Exact current-main production-flavor unsigned macOS package and ordinary existing screen access. Actual running/closed screenshots use a saved/restored disposable Dock layout. The owned app exposes an ephemeral loopback Chromium endpoint only so Playwright can click its actual visible renderer Quit confirmation after the native termination request; no IPC or source shortcut. Original author/current asset exports are separately labelled; original author application was not built/rendered. No permission request, TCC or accessibility changes, authenticated provider session, signing, release, or upgrade/cache-transition claim.",
    });
    run(
      "/usr/bin/swiftc",
      [
        "-swift-version",
        "5",
        join(driver, ".github/scripts/mac-dock-lifecycle.swift"),
        "-o",
        setup.helper,
      ],
      { timeout: 60_000, log: "compile-native-helper.log" },
    );
    native("preflight", setup);
    run("/usr/bin/iconutil", [
      "-c",
      "iconset",
      join(author, "apps/desktop/resources/icon.icns"),
      "-o",
      join(evidence, "author.iconset"),
    ]);
    run("/usr/bin/iconutil", [
      "-c",
      "iconset",
      join(source, "apps/desktop/resources/icon.icns"),
      "-o",
      join(evidence, "current.iconset"),
    ]);
    copyFileSync(
      join(evidence, "author.iconset/icon_512x512@2x.png"),
      join(evidence, "original-author-bundle-artwork.png"),
    );
    copyFileSync(
      join(evidence, "current.iconset/icon_512x512@2x.png"),
      join(evidence, "current-main-legacy-bundle-artwork.png"),
    );
    copyFileSync(
      join(source, "apps/desktop/resources/dock-icon.png"),
      join(evidence, "current-main-legacy-runtime-artwork.png"),
    );
    appendFileSync(process.env.GITHUB_ENV, `DOCK_EVIDENCE=${evidence}\n`);
    return;
  }
  if (phase === "cleanup" && !existsSync(statePath)) {
    save("cleanup-result.json", {
      cleaned: true,
      configured: false,
      reason: "Preparation never created an owned experiment",
    });
    return;
  }
  const setup = state();
  assert.ok(setup.ownedRoot.startsWith(join(process.env.RUNNER_TEMP, "mac-dock-owned-")));
  assert.equal(setup.appPath, join(setup.ownedRoot, "expanded", "Synara.app"));
  assert.equal(setup.configurationPath, join(setup.ownedRoot, "capture-configuration.json"));
  assert.equal(setup.helper, join(setup.ownedRoot, "mac-dock-lifecycle"));
  if (phase === "cleanup") {
    if (!existsSync(setup.helper)) {
      assert.ok(!existsSync(join(setup.ownedRoot, "dock-preferences-before.plist")));
      save("cleanup-result.json", {
        cleaned: true,
        configured: false,
        reason: "Native helper was never compiled; no Dock mutation occurred",
      });
      return;
    }
    const failures = [];
    for (const operation of ["cleanup", "restore"]) {
      try {
        native(operation, setup);
      } catch (error) {
        failures.push({ operation, error: String(error) });
      }
    }
    if (existsSync(setup.appPath)) {
      try {
        run(
          "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
          ["-u", setup.appPath],
          { log: "unregister-owned-app.log" },
        );
      } catch (error) {
        failures.push({ operation: "unregister-owned-app", error: String(error) });
      }
    }
    save("cleanup-result.json", { failures, cleaned: failures.length === 0 });
    assert.equal(failures.length, 0, "Disposable state cleanup failed");
    return;
  }
  if (phase === "capture") {
    const zipNames = readdirSync(assets).filter((name) => name.endsWith(".zip"));
    assert.equal(zipNames.length, 1, "Exactly one actual update ZIP is required");
    const zip = join(assets, zipNames[0]);
    const expanded = dirname(setup.appPath);
    mkdirSync(expanded);
    run("/usr/bin/ditto", ["-x", "-k", zip, expanded], {
      timeout: 120_000,
      log: "extract-package.log",
    });
    assert.deepEqual(readdirSync(expanded), ["Synara.app"]);
    const executable = join(setup.appPath, "Contents/MacOS/Synara");
    const embedded = JSON.parse(
      run(
        executable,
        [
          "-e",
          `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(setup.appPath, "Contents/Resources/app.asar/package.json"))},'utf8'))`,
        ],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      ),
    );
    const provenance = JSON.parse(readFileSync(join(evidence, "provenance.json"), "utf8"));
    assert.equal(embedded.synaraCommitHash, sourceSha);
    assert.equal(embedded.synaraLockfileSha256, provenance.lockfileSha256);
    assert.equal(embedded.synaraDesktopFlavor, "production");
    assert.equal(embedded.version, setup.version);
    const hashes = await coreHashes(setup.appPath);
    assert.equal(hashes["Contents/Resources/Assets.car"], (await verifyIconCatalog()).sha256);
    save("package-identity.json", {
      sourceSha,
      sourceTree,
      appPath: setup.appPath,
      zip: { file: zipNames[0], bytes: statSync(zip).size, sha256: await digest(zip) },
      embedded: {
        commit: embedded.synaraCommitHash,
        lock: embedded.synaraLockfileSha256,
        flavor: embedded.synaraDesktopFlavor,
        version: embedded.version,
      },
      hashes,
    });
    let captureError;
    const cleanupFailures = [];
    try {
      native("configure", setup);
      await captureWithActualQuitConfirmation(setup);
    } catch (error) {
      captureError = error;
      save("original-capture-failure.json", { message: String(error), stack: error.stack });
    } finally {
      for (const operation of ["cleanup", "restore"]) {
        try {
          native(operation, setup);
        } catch (error) {
          cleanupFailures.push({ operation, message: String(error) });
          save(`capture-finally-${operation}-failure.json`, { message: String(error) });
        }
      }
      const log = JSON.parse(readFileSync(setup.configurationPath, "utf8")).startupLog;
      if (existsSync(log)) copyFileSync(log, join(evidence, "captured-app-desktop-main.log"));
      save("core-payload-after.json", await coreHashes(setup.appPath));
    }
    if (captureError) throw captureError;
    assert.equal(cleanupFailures.length, 0, "Capture cleanup failed; original failures retained");
    assert.deepEqual(
      await coreHashes(setup.appPath),
      hashes,
      "Application executable, ASAR or bundle icon changed",
    );
    return;
  }
  const outcome = JSON.parse(readFileSync(join(evidence, "lifecycle-result.json"), "utf8"));
  assert.ok(outcome.runningCapture && outcome.normalQuit && outcome.closedCapture);
  assert.equal(process.env.DOCK_BUILD_OUTCOME, "success");
  assert.equal(process.env.DOCK_STARTUP_OUTCOME, "success");
  assert.equal(process.env.DOCK_CAPTURE_OUTCOME, "success");
  assert.equal(process.env.DOCK_CLEANUP_OUTCOME, "success");
  const confirmation = JSON.parse(
    readFileSync(join(evidence, "renderer-confirmation.json"), "utf8"),
  );
  assert.ok(confirmation.visiblePrompt && confirmation.visibleButton && confirmation.clicked);
  const images = [];
  for (const file of [
    "current-main-closed-before-launch.png",
    "current-main-running.png",
    "current-main-closed-after-quit.png",
    "original-author-bundle-artwork.png",
    "current-main-legacy-bundle-artwork.png",
    "current-main-legacy-runtime-artwork.png",
  ]) {
    const bytes = readFileSync(join(evidence, file));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    images.push({
      file,
      bytes: bytes.length,
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      sha256: await digest(join(evidence, file)),
    });
  }
  assertSources();
  save("qualification.json", {
    sourceSha,
    driverSha: process.env.GITHUB_SHA,
    lifecycle: outcome,
    images,
    passed: true,
    visualReviewPending: true,
  });
}
await main().catch((error) => {
  save(`${phase}-failure.json`, { message: String(error), stack: error.stack });
  console.error(error);
  // Bound failed observer connections; the always-running workflow cleanup
  // still restores the Dock and terminates only the exact owned application.
  process.exit(1);
});

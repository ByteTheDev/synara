// Inspect actual packaged application APIs and capture native macOS menus.
// No application source, menu callbacks, permission grants or provider replies are replaced.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const identities = {
  before: {
    sha: "ec8c940e07582454a475250ade40147e3c89d59f",
    tree: "26c3b060469f224dce8135d8046697eb43fe0794",
  },
  after: {
    sha: "ac0e7f65b6860dbc4e7c308acbc01a886238f559",
    tree: "57aefecc130961e170bc46ebfbafef8b6fd880eb",
  },
};
const label = process.env.AOT_LABEL;
assert.ok(Object.hasOwn(identities, label));
const identity = identities[label];
assert.equal(process.env.AOT_SOURCE_SHA, identity.sha);
const source = process.cwd();
const driver = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = join(process.env.RUNNER_TEMP, "always-on-top-evidence");
const statePath = join(process.env.RUNNER_TEMP, "always-on-top-state.json");
const packages = join(process.env.RUNNER_TEMP, "always-on-top-packages");
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
    timeout,
    shell: false,
    encoding: "utf8",
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
  assert.equal(run("git", ["rev-parse", "HEAD"]), identity.sha);
  assert.equal(run("git", ["rev-parse", "HEAD^{tree}"]), identity.tree);
  assert.equal(run("git", ["diff", "--exit-code", "HEAD", "--"]), "");
  assert.equal(run("git", ["rev-parse", "HEAD"], { cwd: driver }), process.env.GITHUB_SHA);
  assert.equal(
    run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: driver }),
    "",
  );
}
async function iconReceipt() {
  const path = join(process.env.RUNNER_TEMP, "always-on-top-icon", "Assets.car");
  assert.equal(process.env.SYNARA_MAC_ICON_CATALOG, path);
  assert.equal(readFileSync(join(dirname(path), "source-commit.txt"), "utf8").trim(), identity.sha);
  const line = readFileSync(join(dirname(path), "Assets.car.sha256"), "utf8").trim();
  assert.match(line, /^[0-9a-f]{64} [ *]Assets\.car$/);
  assert.equal(await digest(path), line.slice(0, 64));
  assert.ok(statSync(path).size > 0);
  return { sourceSha: identity.sha, sha256: line.slice(0, 64), bytes: statSync(path).size };
}
function setupState() {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.ok(state.root.startsWith(join(process.env.RUNNER_TEMP, "always-on-top-owned-")));
  assert.equal(state.appPath, join(state.root, "expanded", "Synara.app"));
  assert.equal(state.configPath, join(state.root, "capture-config.json"));
  assert.equal(state.helper, join(state.root, "always-on-top-screen"));
  return state;
}
function native(state, mode, imageLabel, expected) {
  return run(state.helper, [mode, state.configPath, imageLabel, ...(expected ? [expected] : [])], {
    timeout: 60_000,
    log: `${imageLabel}-native.log`,
  });
}
async function deadline(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(description + " deadline")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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
  if (phase !== "cleanup") assertSources();
  if (phase === "prepare") {
    appendFileSync(process.env.GITHUB_ENV, `AOT_EVIDENCE=${evidence}\n`);
    assert.equal(run("git", ["status", "--porcelain=v1", "--untracked-files=all"]), "");
    assert.ok(!existsSync(statePath));
    const root = mkdtempSync(join(process.env.RUNNER_TEMP, "always-on-top-owned-"));
    const version = JSON.parse(
      readFileSync(join(source, "apps/server/package.json"), "utf8"),
    ).version;
    const canonical = await import(
      pathToFileURL(join(source, "scripts/verify-packaged-desktop-startup.ts")).href
    );
    const fullEnvironment = canonical.createPackagedDesktopSmokeEnvironment(join(root, "state"), {
      platform: "mac",
      version,
      executableName: "synara",
    });
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
    const state = {
      root,
      version,
      appPath: join(root, "expanded", "Synara.app"),
      configPath: join(root, "capture-config.json"),
      helper: join(root, "always-on-top-screen"),
    };
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
    writeFileSync(
      state.configPath,
      JSON.stringify(
        {
          ownedRoot: root,
          evidence,
          appPath: state.appPath,
          environment,
          startupLog: join(environment.SYNARA_HOME, "userdata", "logs", "desktop-main.log"),
        },
        null,
        2,
      ) + "\n",
    );
    save("provenance.json", {
      label,
      sourceSha: identity.sha,
      sourceTree: identity.tree,
      driverSha: process.env.GITHUB_SHA,
      driverTree: run("git", ["rev-parse", "HEAD^{tree}"], { cwd: driver }),
      run: process.env.GITHUB_RUN_ID,
      version,
      lockfileSha256: await digest(join(source, "bun.lock")),
      mainSha256: await digest(join(source, "apps/desktop/src/main.ts")),
      canonicalStartupSha256: await digest(
        join(source, "scripts/verify-packaged-desktop-startup.ts"),
      ),
      driverScriptSha256: await digest(fileURLToPath(import.meta.url)),
      nativeScriptSha256: await digest(join(driver, ".github/scripts/always-on-top-screen.swift")),
      workflowSha256: await digest(join(driver, ".github/workflows/always-on-top-capture.yml")),
      compiledIcon: await iconReceipt(),
      qualification:
        "Actual unsigned production macOS arm64 package. Playwright's main-process automation opens the unchanged native View submenu with Menu.popup and invokes its unchanged production click handler. Native window state/events and actual macOS screen/z-order are observed. A labelled temporary reference window tests stacking; controlled BrowserWindow.destroy and app activate event test recreation, not ordinary close-confirmation interaction. Actual normal app quit requires clicking the visible unchanged renderer Quit confirmation. No source/menu/reply mock, TCC/accessibility changes, provider session, signing, release, Windows/Linux runtime or Wayland claim.",
    });
    run(
      "/usr/bin/swiftc",
      [
        "-swift-version",
        "5",
        join(driver, ".github/scripts/always-on-top-screen.swift"),
        "-o",
        state.helper,
      ],
      { timeout: 60_000, log: "compile-native.log" },
    );
    native(state, "preflight", `${label}-display-preflight`);
    return;
  }
  if (phase === "cleanup") {
    if (!existsSync(statePath)) {
      save("cleanup-result.json", { cleaned: true, reason: "No owned state was created" });
      return;
    }
    const state = setupState();
    if (!existsSync(state.helper)) {
      save("cleanup-result.json", {
        cleaned: true,
        reason: "Native helper was never compiled; capture did not run",
      });
      return;
    }
    native(state, "cleanup", `${label}-cleanup`);
    if (existsSync(state.appPath))
      run(
        "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        ["-u", state.appPath],
        { log: "unregister-owned-app.log" },
      );
    save("cleanup-result.json", {
      cleaned: true,
      boundary:
        "Only applications with the exact owned bundle URL; remaining descendant teardown is runner-owned and unproven.",
    });
    return;
  }
  const state = setupState();
  if (phase === "verify") {
    for (const name of ["BUILD", "STARTUP", "CAPTURE", "CLEANUP"])
      assert.equal(process.env[`AOT_${name}_OUTCOME`], "success", name);
    const results = JSON.parse(readFileSync(join(evidence, "native-results.json"), "utf8"));
    assert.ok(results.passed && results.normalQuit);
    const required =
      label === "before"
        ? ["before-menu", "before-stacking-off"]
        : [
            "after-menu-off",
            "after-menu-on",
            "after-stacking-off",
            "after-stacking-on",
            "after-menu-recreated",
          ];
    const images = [];
    for (const name of required) {
      const file = join(evidence, name + ".png");
      const bytes = readFileSync(file);
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.ok(bytes.readUInt32BE(16) >= 900 && bytes.readUInt32BE(20) >= 650);
      images.push({
        name: name + ".png",
        bytes: bytes.length,
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
        sha256: await digest(file),
      });
    }
    assert.deepEqual(
      JSON.parse(readFileSync(join(evidence, "core-after.json"), "utf8")),
      JSON.parse(readFileSync(join(evidence, "package-identity.json"), "utf8")).hashes,
    );
    assertSources();
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
      visualReviewPending: true,
      label,
      sourceSha: identity.sha,
      driverSha: process.env.GITHUB_SHA,
      images,
      files,
    });
    return;
  }

  const names = readdirSync(packages).filter((name) => name.endsWith(".zip"));
  assert.equal(names.length, 1);
  const zip = join(packages, names[0]);
  mkdirSync(dirname(state.appPath));
  run("/usr/bin/ditto", ["-x", "-k", zip, dirname(state.appPath)], {
    timeout: 120_000,
    log: "extract-package.log",
  });
  assert.deepEqual(readdirSync(dirname(state.appPath)), ["Synara.app"]);
  const config = JSON.parse(readFileSync(state.configPath, "utf8"));
  const executable = join(state.appPath, "Contents/MacOS/Synara");
  const embedded = JSON.parse(
    run(
      executable,
      [
        "-e",
        `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(state.appPath, "Contents/Resources/app.asar/package.json"))},'utf8'))`,
      ],
      { env: { ...config.environment, ELECTRON_RUN_AS_NODE: "1" } },
    ),
  );
  const provenance = JSON.parse(readFileSync(join(evidence, "provenance.json"), "utf8"));
  assert.equal(embedded.synaraCommitHash, identity.sha);
  assert.equal(embedded.synaraLockfileSha256, provenance.lockfileSha256);
  assert.equal(embedded.synaraDesktopFlavor, "production");
  assert.equal(embedded.version, state.version);
  const hashes = await coreHashes(state.appPath);
  assert.equal(hashes["Contents/Resources/Assets.car"], (await iconReceipt()).sha256);
  save("package-identity.json", {
    sourceSha: identity.sha,
    embedded,
    hashes,
    zip: { file: names[0], bytes: statSync(zip).size, sha256: await digest(zip) },
  });
  const requireWeb = createRequire(join(source, "apps/web/package.json"));
  const playwright = requireWeb("playwright");
  assert.equal(requireWeb("playwright/package.json").version, "1.62.1");
  let app;
  let child;
  let exit = null;
  let normalQuit = false;
  let captureError;
  const observations = [];
  const record = (name, observation) => {
    observations.push({ name, observation });
    save("observations.json", observations);
    return observation;
  };
  const evaluate = (fn, arg) => deadline(app.evaluate(fn, arg), 15_000, "Main-process observation");
  async function snapshot(name) {
    return record(
      name,
      await evaluate(({ app, BrowserWindow, Menu }) => {
        const windows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
        const menu = Menu.getApplicationMenu();
        const item = menu?.getMenuItemById("always-on-top");
        return {
          appPath: app.getAppPath(),
          electron: process.versions.electron,
          windows: windows.map((window) => ({
            id: window.id,
            alwaysOnTop: window.isAlwaysOnTop(),
            visible: window.isVisible(),
          })),
          menu: item ? { enabled: item.enabled, checked: item.checked, type: item.type } : null,
          viewItems: menu?.items
            .find((item) => item.label === "View")
            ?.submenu?.items.map((item) => ({
              label: item.label,
              type: item.type,
              enabled: item.enabled,
              checked: item.checked,
            })),
        };
      }),
    );
  }
  async function expectState(name, on) {
    const current = await snapshot(name);
    assert.equal(current.windows.length, 1);
    assert.equal(current.windows[0].alwaysOnTop, on);
    assert.equal(current.menu?.enabled, true);
    assert.equal(current.menu?.checked, on);
    assert.equal(current.menu?.type, "checkbox");
    return current;
  }
  async function showWindow(existingPage) {
    const page = existingPage ?? (await app.firstWindow({ timeout: 90_000 }));
    await page.waitForLoadState("domcontentloaded");
    await page
      .getByRole("button", { name: "Get started", exact: true })
      .waitFor({ state: "visible", timeout: 30_000 });
    await deadline(
      page.evaluate(() => document.fonts.ready.then(() => Boolean(document.body.innerText.trim()))),
      30_000,
      "Actual renderer fonts",
    ).then((ready) => assert.ok(ready));
    await evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.unmaximize();
      window.setBounds({ x: 30, y: 48, width: 940, height: 660 });
      window.show();
      app.focus({ steal: true });
      window.focus();
    });
    return page;
  }
  async function menuCapture(name) {
    await evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    const opened = await evaluate(
      ({ BrowserWindow, Menu }) =>
        new Promise((resolve, reject) => {
          const window = BrowserWindow.getAllWindows()[0];
          const menu = Menu.getApplicationMenu()?.items.find(
            (item) => item.label === "View",
          )?.submenu;
          if (!menu || !window) {
            reject(new Error("Original native View menu/window is absent"));
            return;
          }
          const timer = setTimeout(() => {
            menu.removeListener("menu-will-show", shown);
            reject(new Error("Native menu did not show"));
          }, 5_000);
          function shown() {
            clearTimeout(timer);
            resolve(true);
          }
          menu.once("menu-will-show", shown);
          menu.popup({ window, x: 24, y: 64 });
        }),
    );
    assert.equal(opened, true);
    try {
      native(state, "capture", name);
    } finally {
      await evaluate(({ BrowserWindow, Menu }) =>
        Menu.getApplicationMenu()
          ?.items.find((item) => item.label === "View")
          ?.submenu?.closePopup(BrowserWindow.getAllWindows()[0]),
      );
    }
  }
  try {
    app = await playwright._electron.launch({
      executablePath: executable,
      args: [],
      env: config.environment,
      cwd: state.root,
      timeout: 90_000,
      artifactsDir: join(state.root, "playwright-artifacts"),
    });
    child = app.process();
    child.once("exit", (code, signal) => {
      exit = { code, signal };
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => appendFileSync(join(evidence, "actual-app-output.log"), chunk));
    writeFileSync(state.configPath, JSON.stringify({ ...config, pid: child.pid }, null, 2) + "\n");
    await showWindow();
    const initial = await snapshot("initial");
    assert.equal(initial.electron, "43.4.1");
    assert.equal(initial.appPath, join(state.appPath, "Contents/Resources/app.asar"));
    assert.equal(initial.windows.length, 1);
    assert.equal(initial.windows[0].alwaysOnTop, false);
    const startup = readFileSync(config.startupLog, "utf8");
    for (const proof of [
      "app ready",
      "bootstrap main window created",
      "bootstrap backend ready source=",
    ])
      assert.ok(startup.includes(proof), proof);
    if (label === "before") {
      assert.equal(initial.menu, null);
      await menuCapture("before-menu");
      native(state, "reference", "before-stacking-off", "below");
    } else {
      await expectState("initial-off", false);
      await menuCapture("after-menu-off");
      native(state, "reference", "after-stacking-off", "below");
      await evaluate(({ BrowserWindow, Menu }) => {
        const item = Menu.getApplicationMenu().getMenuItemById("always-on-top");
        item.click(item, BrowserWindow.getAllWindows()[0], { triggeredByAccelerator: false });
      });
      await expectState("production-menu-on", true);
      await menuCapture("after-menu-on");
      native(state, "reference", "after-stacking-on", "above");
      await evaluate(({ BrowserWindow, Menu }) => {
        const item = Menu.getApplicationMenu().getMenuItemById("always-on-top");
        item.click(item, BrowserWindow.getAllWindows()[0], { triggeredByAccelerator: false });
      });
      await expectState("production-menu-off", false);
      await evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setAlwaysOnTop(true));
      await expectState("external-native-change-on", true);
      await evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setAlwaysOnTop(false));
      await expectState("external-native-change-off", false);
      await evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setAlwaysOnTop(true);
        window.destroy();
      });
      const closed = await snapshot("controlled-window-destroyed");
      assert.equal(closed.windows.length, 0);
      assert.deepEqual(closed.menu, { enabled: false, checked: false, type: "checkbox" });
      const newWindow = app.waitForEvent("window", { timeout: 90_000 }).then(
        (page) => ({ page }),
        (error) => ({ error }),
      );
      await evaluate(({ app }) => {
        app.emit("activate");
      });
      const created = await newWindow;
      assert.equal(created.error, undefined, created.error?.message);
      await showWindow(created.page);
      const recreated = await expectState("recreated-window-off", false);
      assert.notEqual(recreated.windows[0].id, initial.windows[0].id);
      await menuCapture("after-menu-recreated");
    }
  } catch (error) {
    captureError = error;
    save("original-capture-failure.json", { message: String(error), stack: error.stack });
    if (app) {
      // A failed Playwright target must not prevent the actual display capture.
      try {
        native(state, "capture", `${label}-failed-renderer-display`);
      } catch (observationError) {
        save("failed-display-observation-error.json", { message: String(observationError) });
      }
      try {
        const captures = await evaluate(async ({ BrowserWindow }) =>
          Promise.all(
            BrowserWindow.getAllWindows().map(async (window) => ({
              id: window.id,
              url: window.webContents.getURL(),
              png: (await window.webContents.capturePage()).toPNG().toString("base64"),
            })),
          ),
        );
        for (const capture of captures) {
          assert.ok(Number.isSafeInteger(capture.id) && capture.id > 0);
          const bytes = Buffer.from(capture.png, "base64");
          assert.ok(bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")));
          assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
          writeFileSync(join(evidence, `failed-actual-window-${capture.id}.png`), bytes);
          save(`failed-actual-window-${capture.id}.json`, {
            id: capture.id,
            url: capture.url,
            observation: "Unmodified actual BrowserWindow webContents.capturePage()",
          });
        }
      } catch (observationError) {
        save("failed-window-capture-error.json", { message: String(observationError) });
      }
      try {
        save(
          "failed-renderer-windows.json",
          await evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().map((window) => ({
              id: window.id,
              title: window.getTitle(),
              visible: window.isVisible(),
              url: window.webContents.getURL(),
              loading: window.webContents.isLoading(),
              crashed: window.webContents.isCrashed(),
            })),
          ),
        );
        for (const [index, page] of app.windows().entries()) {
          if (page.isClosed()) continue;
          save(
            `failed-renderer-${index}.json`,
            await deadline(
              page.evaluate(() => ({
                url: location.href,
                title: document.title,
                readyState: document.readyState,
                body: document.body?.innerText ?? null,
                buttons: Array.from(document.querySelectorAll("button")).map(
                  (button) => button.innerText,
                ),
              })),
              10_000,
              "Failed renderer observation",
            ),
          );
          await page.screenshot({
            path: join(evidence, `failed-renderer-${index}.png`),
            timeout: 10_000,
          });
        }
      } catch (observationError) {
        save("failed-renderer-observation-error.json", { message: String(observationError) });
      }
    }
  } finally {
    if (app) {
      try {
        const page = app.windows().find((window) => !window.isClosed());
        assert.ok(page, "The actual renderer is required to confirm normal quit");
        const closed = app.waitForEvent("close", { timeout: 30_000 }).then(
          () => ({ closed: true }),
          (error) => ({ closed: false, error }),
        );
        await evaluate(({ app }) => app.quit());
        await page
          .getByText("Are you sure you want to quit?", { exact: true })
          .waitFor({ state: "visible", timeout: 10_000 });
        const quit = page.getByRole("button", { name: "Quit", exact: true });
        await quit.waitFor({ state: "visible", timeout: 10_000 });
        native(state, "capture", `${label}-quit-confirmation`);
        record("normal-quit-confirmation", {
          visiblePrompt: true,
          visibleQuitButton: true,
          interaction: "Click the unchanged actual renderer Quit button",
        });
        await quit.click({ timeout: 10_000 });
        const outcome = await closed;
        assert.ok(outcome.closed, outcome.error?.message);
        normalQuit = child.exitCode === 0;
        assert.ok(normalQuit, "The actual packaged application did not exit normally");
      } catch (error) {
        save("normal-quit-failure.json", {
          message: String(error),
          actualExit: exit,
          exitCode: child?.exitCode,
          signalCode: child?.signalCode,
        });
        captureError ??= error;
      }
    }
    if (existsSync(config.startupLog))
      copyFileSync(config.startupLog, join(evidence, "actual-desktop-main.log"));
    save("normal-quit.json", {
      normalQuit,
      actualExit: exit,
      exitCode: child?.exitCode ?? null,
      signalCode: child?.signalCode ?? null,
    });
    save("core-after.json", await coreHashes(state.appPath));
    save("native-results.json", {
      label,
      sourceSha: identity.sha,
      passed: !captureError && normalQuit,
      normalQuit,
      observations,
      cleanupBoundary:
        "Separate always-running native cleanup targets only the owned app URL. Descendant teardown is runner-owned and unproven.",
    });
  }
  assert.deepEqual(
    await coreHashes(state.appPath),
    hashes,
    "Application source payload or icons changed during capture",
  );
  if (captureError) throw captureError;
}
await main().catch((error) => {
  save(`${phase}-failure.json`, {
    message: String(error),
    stack: error.stack,
    boundary:
      "Failure retained. The workflow's separate native cleanup still runs; no live UI success is claimed.",
  });
  console.error(error);
  // Bound failed automation connections; the next always() step owns cleanup.
  process.exit(1);
});

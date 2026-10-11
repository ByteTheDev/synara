import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCES = {
  before: {
    commit: "9e01962e0b1e8fec9fb0e17f17a64017bc4eaf94",
    tree: "81b2ce105b3362e1266bb15916e0b16633f3843d",
    launcher: "c59a7f91980637387c744344673f1a178eab3b7f",
    test: "12725b08fcdd54a5397385203952529363693770",
    catalog: "assets/prod/Synara.icon",
  },
  after: {
    commit: "4f7c61fe6f028d69ef187c9437286e7830628da4",
    tree: "be7e97e6094034179881fc1b0cbe36b0e3d20c36",
    launcher: "ee3a1bd0cf537499ca84ae71016ac8c38b414ca7",
    test: "b828a62655ccf4aa13651accdd871fa18d7af9cf",
    catalog: "assets/beta/Synara.icon",
  },
};
const phase = process.env.ICON_PHASE;
assert(phase === "before" || phase === "after", "unknown source phase");
const source = SOURCES[phase];
const workspace = realpathSync(process.cwd());
const driver = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.env.ICON_EVIDENCE_OUTPUT ?? "");
const runnerTemp = realpathSync(process.env.RUNNER_TEMP ?? "");
assert(isAbsolute(process.env.ICON_EVIDENCE_OUTPUT ?? ""));
assert.equal(output, join(runnerTemp, `source-icon-${phase}`));
assert.equal(process.env.GITHUB_REPOSITORY, "Emanuele-web04/synara");
assert.equal(process.platform, "darwin");
assert.equal(process.env.SYNARA_DESKTOP_FLAVOR, "beta");
assert.equal(process.versions.bun, "1.4.2");
const mode = process.argv[2];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const writeJson = (name, value) =>
  writeFileSync(join(output, name), `${JSON.stringify(value, null, 2)}\n`);
let commandIndex = 0;

function command(label, executable, args, options = {}) {
  mkdirSync(join(output, "commands"), { recursive: true });
  const stem = `${mode}-${String(++commandIndex).padStart(3, "0")}-${label}`;
  const startedAt = new Date().toISOString();
  const result = spawnSync(executable, args, {
    cwd: workspace,
    ...options,
    encoding: "utf8",
    timeout: Math.min(options.timeout ?? 120_000, 120_000),
    killSignal: "SIGKILL",
    maxBuffer: 8 * 1024 * 1024,
  });
  const observation = {
    label,
    executable,
    args,
    cwd: options.cwd ?? workspace,
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
    error: result.error ? { message: result.error.message, code: result.error.code } : null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    qualification: "Actual bounded synchronous native utility; no descendant-cleanup claim.",
  };
  writeJson(`commands/${stem}.json`, observation);
  return result;
}

function requireSuccess(label, executable, args, options = {}) {
  const result = command(label, executable, args, options);
  assert(!result.error && result.status === 0 && result.signal === null, `${label} failed`);
  return result.stdout;
}

function measure(path) {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: sha256(bytes), gitBlob: blob(bytes) };
}

function sourceGuard(label) {
  const commit = requireSuccess(`${label}-head`, "git", ["rev-parse", "HEAD"]).trim();
  const tree = requireSuccess(`${label}-tree`, "git", ["rev-parse", "HEAD^{tree}"]).trim();
  const status = requireSuccess(`${label}-status`, "git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  const diff = command(`${label}-diff`, "git", ["diff", "--exit-code", "HEAD", "--"]);
  writeJson(`source-${label}.json`, { commit, tree, status, diffStatus: diff.status });
  assert.equal(commit, source.commit);
  assert.equal(tree, source.tree);
  assert.equal(status, "", "source contains tracked or untracked changes");
  assert(!diff.error && diff.status === 0 && diff.stdout === "");
  const pins = {
    "apps/desktop/scripts/electron-launcher.mjs": source.launcher,
    "apps/desktop/scripts/electron-launcher.test.mjs": source.test,
    "bun.lock": "967fc9b407419dafb2e867d18c3f2ccf472745c9",
    "scripts/lib/brand-assets.ts": "45fe38b69568805f4616a81c38cde423ceffdeb2",
    "packages/shared/src/desktopIdentity.ts": "1e37de0cf1e2e122527c17a9d696a1b0f7215bce",
    "apps/desktop/scripts/source-desktop-bootstrap.cjs": "7dedf3d4f4a4f941efcf404f680782f3432c478a",
  };
  for (const [path, sha] of Object.entries(pins))
    assert.equal(measure(join(workspace, path)).gitBlob, sha);
  return { commit, tree };
}

function driverGuard() {
  const commit = requireSuccess("driver-head", "git", ["rev-parse", "HEAD"], {
    cwd: driver,
  }).trim();
  assert.equal(commit, process.env.GITHUB_SHA);
  const paths = [
    "scripts/source-icon-evidence.mjs",
    "scripts/source-icon-render.swift",
    "scripts/source-icon-evidence.md",
    ".github/workflows/source-icon-evidence.yml",
  ];
  return paths.map((path) => {
    const expected = requireSuccess("driver-blob", "git", ["rev-parse", `HEAD:${path}`], {
      cwd: driver,
    }).trim();
    const actual = measure(join(driver, path));
    assert.equal(actual.gitBlob, expected);
    return { path, ...actual };
  });
}

function nativeBuild({ buildMacLauncher }) {
  const desktopDirectory = join(workspace, "apps", "desktop");
  const runtimeDirectory = join(desktopDirectory, ".electron-runtime");
  assert(!existsSync(runtimeDirectory), "refuse a pre-existing launcher runtime");
  const require = createRequire(join(desktopDirectory, "package.json"));
  const electronPackage = require("electron/package.json");
  assert.equal(electronPackage.version, "43.4.1");
  const electron = require("electron");
  assert(isAbsolute(electron) && existsSync(electron));
  const originalBundle = resolve(electron, "../../..");
  const original = {
    binary: measure(electron),
    plist: measure(join(originalBundle, "Contents", "Info.plist")),
  };
  const bundle = join(runtimeDirectory, "Synara Beta.app");
  const lsregister =
    "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";
  const nativeTool = join(output, "render-source-icon");
  requireSuccess("compile-observer", "xcrun", [
    "swiftc",
    join(driver, "scripts", "source-icon-render.swift"),
    "-o",
    nativeTool,
  ]);
  requireSuccess("native-preflight", nativeTool, [
    "preflight",
    join(output, "native-preflight.json"),
  ]);
  let owned = false;
  let failure;
  const actualCalls = [];
  try {
    // The checked-in source creates this directory only after our absence guard.
    // A fresh bundle cannot enter the source's stale-TCC-reset path.
    owned = true;
    const runCommand = (executable, args, options) => {
      assert.notEqual(
        executable,
        "/usr/bin/tccutil",
        "fresh evidence must never reset privacy grants",
      );
      assert(["ditto", "plutil", "xcrun", "/usr/bin/codesign", lsregister].includes(executable));
      const result = command("launcher-native", executable, args, options);
      actualCalls.push({ executable, args, status: result.status, signal: result.signal });
      return result;
    };
    const executable = buildMacLauncher(electron, { desktopDirectory, runCommand });
    assert.equal(executable, join(bundle, "Contents", "MacOS", "Electron"));
    const compilation = actualCalls.filter((entry) => entry.executable === "xcrun");
    assert.equal(compilation.length, 1, "exactly one real asset compilation is required");
    assert.equal(compilation[0].args[0], "actool");
    assert.equal(compilation[0].args[1], join(workspace, source.catalog));
    assert.equal(compilation[0].status, 0);
    assert.equal(compilation[0].signal, null);
    const metadataPath = join(runtimeDirectory, "metadata.json");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (phase === "after") assert.equal(metadata.iconComposerPath, join(workspace, source.catalog));
    else assert.equal(Object.hasOwn(metadata, "iconComposerPath"), false);
    assert.equal(metadata.appVersion, "1.0.3");
    const plist = JSON.parse(
      requireSuccess("bundle-plist", "plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        join(bundle, "Contents", "Info.plist"),
      ]),
    );
    assert.equal(plist.CFBundleIdentifier, "com.emanueledipietro.synara.beta");
    assert.equal(plist.CFBundleDisplayName, "Synara Beta");
    assert.equal(plist.CFBundleIconName, "Synara");
    requireSuccess("verify-generated-signature", "/usr/bin/codesign", [
      "--verify",
      "--deep",
      "--strict",
      bundle,
    ]);
    const signature = command("describe-generated-signature", "/usr/bin/codesign", [
      "--display",
      "--verbose=4",
      bundle,
    ]);
    assert(!signature.error && signature.status === 0 && signature.signal === null);
    const identity = `${signature.stdout ?? ""}\n${signature.stderr ?? ""}`;
    assert.match(identity, /^Signature=adhoc$/m);
    writeJson("bundle-plist.json", plist);
    copyFileSync(metadataPath, join(output, "launcher-metadata.json"));
    const materialPaths = [
      "Contents/MacOS/Electron",
      "Contents/Info.plist",
      "Contents/Resources/Assets.car",
      "Contents/Resources/icon.icns",
      "Contents/Resources/app/main.cjs",
    ];
    const material = () => materialPaths.map((path) => ({ path, ...measure(join(bundle, path)) }));
    const firstMaterial = material();
    assert(firstMaterial.every((entry) => entry.bytes > 0));
    const firstMetadata = measure(metadataPath);
    const callCount = actualCalls.length;
    assert.equal(buildMacLauncher(electron, { desktopDirectory, runCommand }), executable);
    assert.equal(
      actualCalls.length,
      callCount,
      "identical source must reuse the signed launcher without native commands",
    );
    assert.deepEqual(material(), firstMaterial);
    assert.deepEqual(measure(metadataPath), firstMetadata);
    requireSuccess("render-actual-bundle-icon", nativeTool, [
      "render",
      bundle,
      join(output, "source-bundle-icon.png"),
      join(output, "appkit-render.json"),
    ]);
    const render = JSON.parse(readFileSync(join(output, "appkit-render.json"), "utf8"));
    assert.equal(render.bundle, bundle);
    assert.equal(render.width, 1024);
    assert.equal(render.height, 1024);
    assert(render.visiblePixels > 50_000);
    assert.deepEqual(
      material(),
      firstMaterial,
      "rendering must leave signed bundle bytes unchanged",
    );
    assert.deepEqual(measure(electron), original.binary);
    assert.deepEqual(measure(join(originalBundle, "Contents", "Info.plist")), original.plist);
    writeJson("native-result.json", {
      phase,
      source,
      electronVersion: electronPackage.version,
      originalElectron: original,
      bundle,
      compiledCatalog: source.catalog,
      actualCalls,
      material: firstMaterial,
      cacheReuse: { nativeCommands: 0, signedMaterialUnchanged: true, metadataUnchanged: true },
      icon: measure(join(output, "source-bundle-icon.png")),
      signatureDescription: identity,
      qualification:
        "Real source bundle, actool, ad-hoc signature and AppKit icon rendering. No app launch, Dock lifecycle, TCC reset, packaged release, flat fallback or native legacy-cache migration execution.",
    });
  } catch (error) {
    failure = error;
    writeJson("native-failure.json", { message: error.message, stack: error.stack, actualCalls });
  } finally {
    const cleanup = {
      owned,
      bundleExisted: existsSync(bundle),
      unregister: null,
      removed: false,
      error: null,
    };
    try {
      if (owned && existsSync(bundle) && existsSync(lsregister)) {
        const result = command("unregister-owned-bundle", lsregister, ["-u", bundle]);
        cleanup.unregister = {
          status: result.status,
          signal: result.signal,
          error: result.error?.message ?? null,
        };
        if (result.error || result.status !== 0)
          throw new Error("owned launcher unregister failed");
      }
    } catch (error) {
      cleanup.error = error.message;
      failure ??= error;
    } finally {
      try {
        if (owned) rmSync(runtimeDirectory, { recursive: true, force: true });
        cleanup.removed = !existsSync(runtimeDirectory);
        assert(cleanup.removed);
      } catch (error) {
        cleanup.error = `${cleanup.error ?? ""} ${error.message}`.trim();
        failure ??= error;
      }
      writeJson("cleanup.json", cleanup);
    }
  }
  try {
    sourceGuard("after-native");
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

if (mode === "prepare") {
  assert(!existsSync(output), "evidence directory must be new");
  mkdirSync(output, { recursive: true });
  const checked = sourceGuard("prepare");
  const driverFiles = driverGuard();
  const catalogFiles = requireSuccess("catalog-inventory", "git", [
    "ls-tree",
    "-r",
    "--name-only",
    "HEAD",
    "--",
    "assets/prod/Synara.icon",
    "assets/beta/Synara.icon",
  ])
    .trim()
    .split("\n");
  const catalogs = catalogFiles.map((path) => ({ path, ...measure(join(workspace, path)) }));
  assert.equal(catalogs.length, 6);
  assert(catalogs.every((entry) => entry.bytes > 0));
  writeJson("provenance.json", {
    phase,
    source: checked,
    selectedCatalog: source.catalog,
    driverCommit: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    platform: process.platform,
    architecture: process.arch,
    nodeCompatibility: process.version,
    node: requireSuccess("node-version", "node", ["--version"]).trim(),
    bun: process.versions.bun,
    driverFiles,
    catalogs,
    system: requireSuccess("system-version", "/usr/bin/sw_vers", []),
    xcode: requireSuccess("xcode-version", "xcodebuild", ["-version"]),
  });
  for (const entry of driverFiles)
    copyFileSync(join(driver, entry.path), join(output, `driver-${entry.path.split("/").at(-1)}`));
} else if (mode === "guard") {
  sourceGuard("after-install");
} else if (mode === "native") {
  sourceGuard("before-native");
  driverGuard();
  const launcher = await import(
    pathToFileURL(join(workspace, "apps/desktop/scripts/electron-launcher.mjs")).href
  );
  nativeBuild(launcher);
} else if (mode === "finalize") {
  let failure;
  try {
    sourceGuard("final");
    driverGuard();
    assert(existsSync(join(output, "native-result.json")), "native proof is missing");
    assert(!existsSync(join(output, "native-failure.json")), "native failure remains");
    const cleanup = JSON.parse(readFileSync(join(output, "cleanup.json"), "utf8"));
    assert(cleanup.removed && cleanup.error === null);
    if (phase === "after") {
      const live = join(runnerTemp, "source-icon-after-live-tests.json");
      const observed = readFileSync(live);
      writeFileSync(join(output, "launcher-tests.json"), observed);
      writeJson("test-report-snapshot.json", {
        capturedAt: new Date().toISOString(),
        bytes: observed.length,
        sha256: sha256(observed),
        qualification:
          "One copied observation after the workflow test step; missing/partial/failed reports are rejected.",
      });
      const report = JSON.parse(observed.toString("utf8"));
      assert.equal(report.numTotalTests, 22);
      assert.equal(report.numPassedTests, 22);
      assert.equal(report.numFailedTests, 0);
      assert.equal(report.numPendingTests, 0);
      assert.equal(report.success, true);
    }
  } catch (error) {
    failure = error;
    writeJson("finalization-failure.json", { message: error.message, stack: error.stack });
  }
  const files = [];
  function inventory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      assert(!lstatSync(path).isSymbolicLink(), "evidence cannot contain symlinks");
      if (entry.isDirectory()) inventory(path);
      else if (entry.name !== "manifest.json")
        files.push({ path: relative(output, path), ...measure(path) });
    }
  }
  inventory(output);
  writeJson("manifest.json", { phase, source, complete: !failure, files });
  if (failure) throw failure;
} else throw new Error(`unknown mode ${mode}`);

import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pins = {
  before: {
    source: "25b55b0bec0914d81e4db54b27f953721b067b29",
    tree: "00d8c27b49524a93e219c03c8639638e6415354c",
  },
  after: {
    source: "6d3682aa9123d02b560131ae363e0b627e634447",
    tree: "d6898a297b37af10ff79502796f3f207db3667e7",
  },
};
const variant = process.env.HOMEBREW_DOCS_VARIANT;
assert.ok(Object.hasOwn(pins, variant));
assert.ok(["linux", "darwin"].includes(process.platform));
const pin = pins[variant];
const root = resolve(process.env.GITHUB_WORKSPACE, "source");
const site = join(root, "apps/marketing");
const helper = dirname(fileURLToPath(import.meta.url));
const driver = resolve(helper, "../../..");
const out = join(process.env.RUNNER_TEMP, "homebrew-docs-evidence");
const manifestPath = join(out, "provenance.json");
const golden = `apps/marketing/tests/visual/visual.spec.ts-snapshots/docs-desktop-light-${process.platform}.png`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const gitDriver = (...args) => execFileSync("git", args, { cwd: driver, encoding: "utf8" }).trim();
const phase = process.argv[2];
function sourceGuard() {
  assert.equal(git("rev-parse", "HEAD"), pin.source);
  assert.equal(git("rev-parse", "HEAD^{tree}"), pin.tree);
  assert.equal(gitDriver("rev-parse", "HEAD"), process.env.GITHUB_SHA);
  assert.equal(gitDriver("status", "--porcelain=v1", "--untracked-files=all"), "");
}
const save = (name, value) => writeFileSync(join(out, name), JSON.stringify(value, null, 2) + "\n");
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
sourceGuard();
if (phase === "prepare") {
  assert.equal(git("status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.ok(!existsSync(out));
  mkdirSync(out);
  const fixture = JSON.parse(
    readFileSync(join(site, "src/data/latest-release-downloads.json"), "utf8"),
  );
  assert.equal(fixture.version, "v0.8.1");
  const copies = [
    ["capture.spec.ts", "tests/e2e/homebrew-docs.spec.ts"],
    ["capture.config.ts", "playwright.homebrew-proof.config.ts"],
  ];
  for (const [from, to] of copies) {
    assert.ok(!existsSync(join(site, to)));
    copyFileSync(join(helper, from), join(site, to));
  }
  save("provenance.json", {
    source: pin.source,
    sourceTree: pin.tree,
    variant,
    platform: process.platform,
    arch: process.arch,
    driver: process.env.GITHUB_SHA,
    driverTree: gitDriver("rev-parse", "HEAD^{tree}"),
    run: process.env.GITHUB_RUN_ID,
    fixture,
    lockfileSha256: digest(readFileSync(join(root, "bun.lock"))),
    sourceFiles: [
      "content/docs/index.mdx",
      "content/docs/getting-started/installation.mdx",
      "content/docs/troubleshooting/desktop-and-updates.mdx",
      "src/components/InstallOptions.tsx",
      "src/lib/docs.ts",
      "src/app/docs/[[...slug]]/page.tsx",
      "src/data/latest-release-downloads.json",
      "tests/test-helpers.ts",
      "tests/visual/visual.spec.ts",
      "playwright.config.ts",
    ].map((path) => ({
      path,
      gitBlob: git("rev-parse", "HEAD:apps/marketing/" + path),
      sha256: digest(readFileSync(join(site, path))),
    })),
    captureFiles: copies.map(([from, to]) => ({
      path: to,
      sha256: digest(readFileSync(join(helper, from))),
    })),
    driverFiles: ["runner.mjs", "capture.spec.ts", "capture.config.ts"].map((path) => ({
      path,
      sha256: digest(readFileSync(join(helper, path))),
    })),
    workflowSha256: digest(readFileSync(join(driver, ".github/workflows/homebrew-docs-proof.yml"))),
    originalGolden: {
      path: golden,
      gitBlob: git("rev-parse", "HEAD:" + golden),
      sha256: digest(readFileSync(join(root, golden))),
    },
    qualification:
      "Actual production Next documentation and /install, actual Chromium, exact checked-in VISUAL_TEST v0.8.1 release fixture. Original docs root snapshot/assertions run unchanged and their real failure remains a failing workflow step. Candidate shared docs-root golden is generated only from exact current-main Before source for independent review, not reported as an original baseline pass. No native application, Homebrew install, upstream acceptance or arbitrary API mock claim.",
  });
  appendFileSync(
    process.env.GITHUB_ENV,
    `HOMEBREW_DOCS_OUTPUT=${out}\nHOMEBREW_DOCS_SOURCE=${pin.source}\n`,
  );
} else if (phase === "run") {
  const label = process.argv[3];
  const expected = {
    build: ["bun", "run", "build"],
    "original-snapshot": [
      "bunx",
      "playwright",
      "test",
      "tests/visual/visual.spec.ts",
      "--grep",
      "docs-desktop-light",
      "--retries=0",
      "--output",
      join(out, "original-snapshot"),
    ],
    capture: ["bunx", "playwright", "test", "--config", "playwright.homebrew-proof.config.ts"],
    "generate-golden": [
      "bunx",
      "playwright",
      "test",
      "tests/visual/visual.spec.ts",
      "--grep",
      "docs-desktop-light",
      "--retries=0",
      "--update-snapshots",
      "--output",
      join(out, "golden-generation"),
    ],
  };
  assert.ok(Object.hasOwn(expected, label));
  if (label === "generate-golden") assert.equal(variant, "before");
  assert.equal(process.argv[4], "--");
  const args = process.argv.slice(5);
  assert.deepEqual(args, expected[label]);
  assert.equal(process.cwd(), site);
  const child = spawn(args[0], args.slice(1), {
    cwd: site,
    env: process.env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      appendFileSync(join(out, label + ".log"), chunk);
      process.stdout.write(chunk);
    });
  const result = await new Promise((resolveResult) => {
    let rootExit = null;
    let processError = null;
    let expired = false;
    let finished = false;
    let drain;
    const finish = (closeCode, closeSignal, outputCut = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(drain);
      resolveResult({
        rootExit,
        processError,
        closeCode,
        closeSignal,
        observerDeadline: expired,
        outputCut,
        exitCode: expired ? 124 : processError ? 1 : (closeCode ?? 1),
      });
    };
    const timer = setTimeout(() => {
      expired = true;
      drain = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null, null, true);
      }, 10_000);
      try {
        child.kill("SIGKILL");
      } catch (error) {
        processError = String(error);
      }
    }, 15 * 60_000);
    child.once("exit", (code, signal) => {
      rootExit = { code, signal };
    });
    child.once("error", (error) => {
      processError = String(error);
      if (!expired) finish(null, null);
    });
    child.once("close", (code, signal) => finish(code, signal));
  });
  save(label + "-result.json", {
    ...result,
    command: args,
    cwd: relative(root, site),
    scope:
      "On observer deadline only the owned ChildProcess handle is signalled. Descendant teardown is runner-owned; forced output cutoff is explicit.",
  });
  process.exitCode = result.exitCode;
} else if (phase === "verify") {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const requireSite = createRequire(join(site, "package.json"));
  const playwrightVersion = requireSite("@playwright/test/package.json").version;
  assert.equal(playwrightVersion, "1.62.1");
  const changed = git("diff", "HEAD", "--name-only").split("\n").filter(Boolean);
  assert.ok(
    changed.every((path) => variant === "before" && path === golden),
    `Unexpected source changes: ${changed}`,
  );
  assert.equal(digest(readFileSync(join(root, "bun.lock"))), manifest.lockfileSha256);
  for (const item of manifest.sourceFiles)
    assert.equal(digest(readFileSync(join(site, item.path))), item.sha256, item.path);
  for (const item of manifest.captureFiles)
    assert.equal(digest(readFileSync(join(site, item.path))), item.sha256, item.path);
  const results = Object.fromEntries(
    [
      "build",
      "original-snapshot",
      "capture",
      ...(variant === "before" ? ["generate-golden"] : []),
    ].map((name) => [name, JSON.parse(readFileSync(join(out, name + "-result.json"), "utf8"))]),
  );
  const observations = ["desktop", "mobile"].map((layout) =>
    JSON.parse(readFileSync(join(out, `observations-${layout}.json`), "utf8")),
  );
  for (const value of observations) {
    assert.equal(value.source, pin.source);
    assert.equal(value.variant, variant);
    assert.equal(value.platform, process.platform);
    assert.ok(value.installCalloutAbsent);
  }
  for (const layout of ["desktop", "mobile"])
    for (const name of ["installation", "updates", "install-page"]) {
      const file = join(out, `${name}-${layout}.png`);
      const bytes = readFileSync(file);
      assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
      assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0);
    }
  if (variant === "before") {
    mkdirSync(join(out, "candidate-golden"));
    copyFileSync(join(root, golden), join(out, "candidate-golden", golden.split("/").at(-1)));
  }
  const files = walk(out)
    .filter((path) => path !== manifestPath)
    .map((path) => ({
      path: relative(out, path),
      bytes: statSync(path).size,
      sha256: digest(readFileSync(path)),
    }));
  const passed =
    results.build.exitCode === 0 &&
    results.capture.exitCode === 0 &&
    (variant !== "before" || results["generate-golden"].exitCode === 0);
  save("provenance.json", {
    ...manifest,
    playwrightVersion,
    capturePassed: passed,
    originalSnapshotPassed: results["original-snapshot"].exitCode === 0,
    results,
    observations,
    changedTrackedFiles: changed,
    files,
  });
  if (!passed) process.exitCode = 1;
} else throw new Error("Expected prepare, run or verify");

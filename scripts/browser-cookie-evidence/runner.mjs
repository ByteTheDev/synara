import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const directory = dirname(fileURLToPath(import.meta.url));
const driverRoot = resolve(directory, "../..");
const targets = JSON.parse(readFileSync(resolve(directory, "targets.json"), "utf8"));
const overlay = JSON.parse(readFileSync(resolve(directory, "overlay.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlob = (bytes) =>
  createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const driverPaths = [
  ".github/workflows/browser-cookie-evidence.yml",
  ...[
    "runner.mjs",
    "targets.json",
    "overlay.json",
    "helpers.tsx",
    "vitest.cookie-evidence.config.ts",
    "README.md",
  ].map((name) => "scripts/browser-cookie-evidence/" + name),
];
const configPath = "apps/web/vitest.cookie-evidence.config.ts";
const sourcePaths = [
  "apps/web/src/components/BrowserVault.browser.tsx",
  "apps/web/src/components/SafariAccessOnboarding.browser.tsx",
  "apps/web/src/components/BrowserCookieImport.tsx",
  "apps/web/src/components/BrowserVault.tsx",
  "apps/web/src/components/SafariAccessOnboarding.tsx",
  "packages/contracts/src/browserVault.ts",
  "apps/web/src/hooks/useTheme.ts",
  "apps/web/src/index.css",
  "bun.lock",
];
if (
  targets.length !== 4 ||
  new Set(targets.map((target) => target.id)).size !== 4 ||
  targets.some(
    (target) =>
      !/^pr1856-(before|after)-(desktop|mobile)$/.test(target.id) ||
      target.id !== "pr1856-" + target.variant + "-" + target.viewport ||
      ![360, 760].includes(target.width) ||
      target.height !== 1000 ||
      target.width !== (target.viewport === "desktop" ? 760 : 360) ||
      !/^[a-f0-9]{40}$/.test(target.source) ||
      !/^[a-f0-9]{40}$/.test(target.tree),
  )
)
  throw new Error("Exactly four reviewed source/viewport targets are required.");
if (
  overlay.fixtures.length !== 2 ||
  overlay.expectedCases !== 27 ||
  overlay.fixtures.map((entry) => entry.expectedCases).join(",") !== "15,12"
)
  throw new Error("Both complete canonical browser files are required.");

function fileProof(cwd, path) {
  const bytes = readFileSync(resolve(cwd, path));
  const blob = git(cwd, "rev-parse", "HEAD:" + path);
  if (gitBlob(bytes) !== blob) throw new Error("Tracked source bytes differ from Git: " + path);
  return { path, bytes: bytes.length, blob, sha256: digest(bytes) };
}
function assertSource(target) {
  if (
    git(root, "rev-parse", "HEAD") !== target.source ||
    git(root, "rev-parse", "HEAD^{tree}") !== target.tree ||
    git(root, "diff", "HEAD", "--name-only")
  )
    throw new Error("The full tracked application must stay at its exact clean source.");
  return sourcePaths.map((path) => fileProof(root, path));
}
function assertDriver() {
  if (git(driverRoot, "diff", "HEAD", "--name-only")) throw new Error("Driver checkout changed.");
  const proofs = driverPaths.map((path) => fileProof(driverRoot, path));
  for (const fixture of overlay.fixtures) {
    const proof = fileProof(driverRoot, fixture.path);
    if (
      proof.blob !== fixture.blob ||
      proof.sha256 !== fixture.sha256 ||
      proof.bytes !== fixture.bytes
    )
      throw new Error("The original common canonical fixture changed: " + fixture.path);
  }
  return proofs;
}
function observedFixture(fixture) {
  const original = readFileSync(resolve(driverRoot, fixture.path), "utf8");
  const helpers = readFileSync(resolve(directory, "helpers.tsx"), "utf8") + "\n";
  let observed = original;
  for (const { before, after } of fixture.replacements) {
    if (observed.split(before).length !== 2)
      throw new Error("Expected one additive observation boundary.");
    observed = observed.replace(before, after);
  }
  if (observed.split(fixture.helperAnchor).length !== 2)
    throw new Error("Expected one canonical helper boundary.");
  observed =
    fixture.imports + observed.replace(fixture.helperAnchor, helpers + fixture.helperAnchor);
  let reversed = observed.slice(fixture.imports.length).replace(helpers, "");
  for (const { before, after } of [...fixture.replacements].reverse()) {
    if (reversed.split(after).length !== 2) throw new Error("Observation reversal is ambiguous.");
    reversed = reversed.replace(after, before);
  }
  if (reversed !== original || digest(observed) !== fixture.observedSha256)
    throw new Error("The complete original canonical fixture was modified.");
  return { original, observed };
}
function inventory(path, prefix = "") {
  const result = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Unexpected evidence symlink.");
    const relative = prefix + entry.name;
    if (entry.isDirectory()) result.push(...inventory(resolve(path, entry.name), relative + "/"));
    else if (entry.isFile()) {
      const bytes = readFileSync(resolve(path, entry.name));
      result.push({
        path: relative,
        bytes: bytes.length,
        sha256: digest(bytes),
        blob: gitBlob(bytes),
      });
    } else throw new Error("Unexpected evidence entry.");
  }
  return result;
}
const command = process.argv[2];
if (command === "matrix") {
  if (!process.env.GITHUB_OUTPUT) throw new Error("Missing GitHub matrix output.");
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    "matrix=" + JSON.stringify({ include: targets }) + "\n",
  );
} else if (command === "prepare") {
  const target = targets.find((entry) => entry.id === process.env.COOKIE_TARGET);
  if (!target || target.source !== process.env.COOKIE_SOURCE)
    throw new Error("Unexpected cookie source target.");
  const sourceFiles = assertSource(target);
  const driverFiles = assertDriver();
  const output = resolve(root, "pr-cookie-evidence", target.id);
  if (existsSync(output)) throw new Error("Evidence output already exists.");
  mkdirSync(output, { recursive: true });
  const overlays = [];
  for (const fixture of overlay.fixtures) {
    const path = resolve(root, fixture.outputPath);
    if (existsSync(path) || git(root, "ls-files", "--", fixture.outputPath))
      throw new Error("Refusing to replace an existing fixture.");
    const { original, observed } = observedFixture(fixture);
    const name = fixture.path.split("/").at(-1);
    writeFileSync(path, observed);
    writeFileSync(resolve(output, "original-" + name), original);
    writeFileSync(resolve(output, "observed-" + name), observed);
    overlays.push({ path: fixture.outputPath, sha256: digest(observed) });
  }
  if (existsSync(resolve(root, configPath)) || git(root, "ls-files", "--", configPath))
    throw new Error("Refusing to replace an existing config.");
  copyFileSync(resolve(directory, "vitest.cookie-evidence.config.ts"), resolve(root, configPath));
  overlays.push({ path: configPath, sha256: digest(readFileSync(resolve(root, configPath))) });
  const temporary = process.env.RUNNER_TEMP;
  if (!temporary || !isAbsolute(temporary))
    throw new Error("Expected an absolute runner-owned temporary directory.");
  const liveDirectory = resolve(temporary, "cookie-evidence-live-" + target.id);
  if (existsSync(liveDirectory)) throw new Error("Live report output already exists.");
  mkdirSync(liveDirectory);
  const liveReport = resolve(liveDirectory, "vitest.json");
  const manifest = {
    target,
    source: target.source,
    sourceTree: target.tree,
    driver: git(driverRoot, "rev-parse", "HEAD"),
    driverTree: git(driverRoot, "rev-parse", "HEAD^{tree}"),
    driverFiles,
    sourceFiles,
    overlays,
    commonFixtures: overlay.fixtures,
    applicationCodeModified: false,
    originalCommonFixturesPreserved: true,
    liveReport,
    qualification:
      "Actual production BrowserCookieImport, BrowserVault and SafariAccessOnboarding with production CSS/theme. Both complete author canonical browser files run unchanged except additive read-only observations and the real useTheme setup with a controlled desktop theme acknowledgement. Original native API/Safari replies and synthetic credentials remain fixtures; no installed-browser detection, Keychain, native cookie transfer or durable Electron session is exercised. The first-run information sheet remains an interim feature, not the unfinished direct onboarding importer.",
    run: process.env.GITHUB_RUN_ID,
    status: "prepared",
  };
  writeFileSync(resolve(output, "provenance.json"), JSON.stringify(manifest, null, 2) + "\n");
  copyFileSync(resolve(directory, "overlay.json"), resolve(output, "overlay.json"));
  if (!process.env.GITHUB_ENV) throw new Error("Missing GitHub environment output.");
  appendFileSync(
    process.env.GITHUB_ENV,
    "VITE_COOKIE_TARGET=" +
      target.id +
      "\n" +
      "VITE_COOKIE_OUTPUT=" +
      output +
      "\n" +
      "VITE_COOKIE_SOURCE=" +
      target.source +
      "\n" +
      "VITE_COOKIE_VARIANT=" +
      target.variant +
      "\n" +
      "VITE_COOKIE_WIDTH=" +
      target.width +
      "\n" +
      "COOKIE_LIVE_REPORT=" +
      liveReport +
      "\n",
  );
  console.log(
    JSON.stringify({ target, driver: manifest.driver, originalCommonFixturesPreserved: true }),
  );
} else if (command === "verify") {
  const output = process.env.VITE_COOKIE_OUTPUT;
  if (!output || !output.startsWith(resolve(root, "pr-cookie-evidence") + "/"))
    throw new Error("Unexpected evidence output directory.");
  const manifest = JSON.parse(readFileSync(resolve(output, "provenance.json"), "utf8"));
  const sourceFiles = assertSource(manifest.target);
  const driverFiles = assertDriver();
  if (
    JSON.stringify(sourceFiles) !== JSON.stringify(manifest.sourceFiles) ||
    JSON.stringify(driverFiles) !== JSON.stringify(manifest.driverFiles)
  )
    throw new Error("Source or driver bytes changed during execution.");
  for (const entry of manifest.overlays)
    if (digest(readFileSync(resolve(root, entry.path))) !== entry.sha256)
      throw new Error("Observed fixture/config was modified.");
  const errors = [];
  const exits = JSON.parse(readFileSync(resolve(output, "exits.json"), "utf8"));
  if (
    Object.keys(exits).sort().join(",") !== "tee,vitest" ||
    Object.values(exits).some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    throw new Error("Invalid actual command/tee exit receipt.");
  let report = null;
  const reportPath = resolve(output, "vitest.json");
  const reportCapture = {
    source: manifest.liveReport,
    capturedAt: new Date().toISOString(),
    exists: false,
  };
  if (existsSync(manifest.liveReport)) {
    const bytes = readFileSync(manifest.liveReport);
    writeFileSync(reportPath, bytes);
    Object.assign(reportCapture, { exists: true, bytes: bytes.length, sha256: digest(bytes) });
    try {
      report = JSON.parse(bytes.toString("utf8"));
    } catch {
      errors.push("The observed original Vitest report was invalid JSON.");
    }
  } else errors.push("The original Vitest report is missing.");
  writeFileSync(
    resolve(output, "report-snapshot.json"),
    JSON.stringify(reportCapture, null, 2) + "\n",
  );
  const log = readFileSync(resolve(output, "vitest.log"), "utf8");
  const prefix = "COOKIE_EVIDENCE_OBSERVATION ";
  const observations = log
    .split("\n")
    .filter((line) => line.includes(prefix))
    .map((line) =>
      line
        .slice(line.indexOf(prefix) + prefix.length)
        .replace(/\x1b\[[0-9;]*m/g, "")
        .trim(),
    )
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const phases = observations.map((entry) => entry.phase);
  if (
    new Set(phases).size !== phases.length ||
    phases.some((phase) => !overlay.expectedPhases.includes(phase))
  )
    errors.push("Unknown or duplicate evidence phase.");
  for (const observed of observations)
    if (
      observed.target !== manifest.target.id ||
      observed.source !== manifest.source ||
      observed.variant !== manifest.target.variant ||
      observed.viewport.width !== manifest.target.width ||
      observed.viewport.height !== 1000 ||
      observed.theme !== "light" ||
      observed.reducedMotion !== true ||
      observed.documentWidth > manifest.target.width
    )
      errors.push(
        "Observation source, viewport, theme or overflow differs from the reviewed target.",
      );
  const files = inventory(output);
  const pngs = files.filter((file) => file.path.endsWith(".png") && !file.path.includes("/"));
  for (const file of pngs) {
    const bytes = readFileSync(resolve(output, file.path));
    if (
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(16) !== manifest.target.width ||
      bytes.readUInt32BE(20) !== 1000
    )
      errors.push("Invalid full viewport PNG: " + file.path);
  }
  const videos = files.filter(
    (file) => file.path.startsWith("video/") && file.path.endsWith(".webm"),
  );
  for (const file of videos)
    if (readFileSync(resolve(output, file.path)).subarray(0, 4).toString("hex") !== "1a45dfa3")
      errors.push("Invalid WebM: " + file.path);
  const assertions = report?.testResults?.flatMap((file) => file.assertionResults ?? []) ?? [];
  if (exits.vitest === 0) {
    if (
      assertions.length !== 27 ||
      assertions.some((test) => test.status !== "passed") ||
      report?.numTotalTests !== 27 ||
      report?.numPassedTests !== 27 ||
      report?.numFailedTests !== 0 ||
      report?.numPendingTests !== 0
    )
      errors.push("All 27 original cases must pass without filtering, skipping or retries.");
    if (
      phases.length !== 6 ||
      pngs.length !== 6 ||
      overlay.expectedPhases.some((phase) => !pngs.some((file) => file.path === phase + ".png"))
    )
      errors.push("All six original interaction observations and screenshots are required.");
    if (videos.length < 1 || videos.length > 2)
      errors.push("Expected the one or two complete contexts for the two canonical files.");
  }
  const actualExitCode = exits.vitest || exits.tee;
  const result = {
    ...manifest,
    status: actualExitCode || errors.length ? "failed" : "completed",
    actualExitCode,
    exits,
    errors,
    reportSnapshot: reportCapture,
    tests: assertions.map(({ fullName, status, failureMessages }) => ({
      fullName,
      status,
      failureMessages,
    })),
    testCounts: report
      ? {
          total: report.numTotalTests,
          passed: report.numPassedTests,
          failed: report.numFailedTests,
          skipped: report.numPendingTests,
        }
      : null,
    observations,
  };
  writeFileSync(resolve(output, "verified.json"), JSON.stringify(result, null, 2) + "\n");
  for (const entry of manifest.overlays) rmSync(resolve(root, entry.path));
  assertSource(manifest.target);
  writeFileSync(
    resolve(output, "manifest.json"),
    JSON.stringify(inventory(output), null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      target: manifest.target.id,
      actualExitCode,
      errors,
      tests: result.testCounts,
      phases,
      pngs: pngs.length,
      videos: videos.length,
    }),
  );
  if (actualExitCode || errors.length) process.exitCode = actualExitCode || 1;
} else throw new Error("Use matrix, prepare or verify.");

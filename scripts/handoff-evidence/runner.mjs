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
const spec = JSON.parse(readFileSync(resolve(directory, "overlay.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const gitBlob = (bytes) =>
  createHash("sha1")
    .update("blob " + Buffer.byteLength(bytes) + "\0")
    .update(bytes)
    .digest("hex");
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 }).trim();
const fixturePath = "apps/web/src/components/PrHandoffEvidence1145.browser.tsx";
const configPath = "apps/web/vitest.handoff-evidence.config.ts";
const driverPaths = [
  ".github/workflows/handoff-evidence.yml",
  ...[
    "runner.mjs",
    "helpers.ts",
    "overlay.json",
    "vitest.handoff-evidence.config.ts",
    "README.md",
  ].map((name) => "scripts/handoff-evidence/" + name),
];
const sourcePaths = [
  spec.fixture.path,
  "apps/web/src/components/ChatView.tsx",
  "apps/web/src/hooks/useThreadHandoff.ts",
  "apps/web/src/lib/threadHandoff.ts",
  "apps/web/src/storeNormalization.ts",
  "apps/web/src/hooks/useTheme.ts",
  "apps/web/src/index.css",
  "apps/server/src/orchestration/decider.ts",
  "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
  "packages/contracts/src/orchestration.ts",
  "packages/shared/package.json",
  "bun.lock",
];
if (
  spec.targets.length !== 2 ||
  spec.expectedCases !== 2 ||
  spec.targets.map((target) => target.variant).join(",") !== "before,after" ||
  spec.targets.some(
    (target) =>
      target.id !== "pr1145-" + target.variant ||
      !/^[a-f0-9]{40}$/.test(target.source) ||
      !/^[a-f0-9]{40}$/.test(target.tree),
  )
)
  throw new Error("Exactly two reviewed handoff sources are required.");

function fileProof(cwd, path) {
  const bytes = readFileSync(resolve(cwd, path));
  const blob = git(cwd, "rev-parse", "HEAD:" + path);
  if (gitBlob(bytes) !== blob) throw new Error("Tracked file differs from its Git bytes: " + path);
  return { path, blob, bytes: bytes.length, sha256: digest(bytes) };
}
function assertSource(target) {
  if (
    git(root, "rev-parse", "HEAD") !== target.source ||
    git(root, "rev-parse", "HEAD^{tree}") !== target.tree ||
    git(root, "diff", "--exit-code", "HEAD", "--name-only")
  )
    throw new Error("The full tracked application must remain at its exact clean source.");
  return sourcePaths.map((path) => fileProof(root, path));
}
function assertDriver() {
  if (git(driverRoot, "diff", "--exit-code", "HEAD", "--name-only"))
    throw new Error("Driver checkout changed.");
  const proofs = driverPaths.map((path) => fileProof(driverRoot, path));
  const fixture = fileProof(driverRoot, spec.fixture.path);
  if (
    fixture.blob !== spec.fixture.blob ||
    fixture.sha256 !== spec.fixture.sha256 ||
    fixture.bytes !== spec.fixture.bytes
  )
    throw new Error("The complete common canonical fixture changed.");
  return proofs;
}
function observedFixture() {
  const original = readFileSync(resolve(driverRoot, spec.fixture.path), "utf8");
  const start = spec.newCases.start;
  const end = spec.newCases.end;
  if (original.split(start).length !== 2 || original.split(end).length !== 2)
    throw new Error("Canonical new-case boundaries are not unique.");
  const offset = original.indexOf(start);
  const main = original.slice(0, offset) + original.slice(original.indexOf(end, offset));
  if (
    gitBlob(main) !== spec.beforeFixture.blob ||
    digest(main) !== spec.beforeFixture.sha256 ||
    Buffer.byteLength(main) !== spec.beforeFixture.bytes
  )
    throw new Error("Removing only the new cases must recover main's entire original fixture.");
  const helpers = readFileSync(resolve(directory, "helpers.ts"), "utf8") + "\n";
  let observed = original;
  for (const { before, after } of spec.replacements) {
    if (observed.split(before).length !== 2) throw new Error("Capture boundary is not unique.");
    observed = observed.replace(before, after);
  }
  if (observed.split(spec.helperAnchor).length !== 2)
    throw new Error("The helper insertion boundary is not unique.");
  observed = observed.replace(spec.helperAnchor, helpers + spec.helperAnchor);
  let reversed = observed.replace(helpers, "");
  for (const { before, after } of [...spec.replacements].reverse()) {
    if (reversed.split(after).length !== 2) throw new Error("Capture reversal is ambiguous.");
    reversed = reversed.replace(after, before);
  }
  if (reversed !== original || digest(observed) !== spec.observedSha256)
    throw new Error("The observation must reverse to the entire unchanged canonical fixture.");
  return { original, observed, main };
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
    "matrix=" + JSON.stringify({ include: spec.targets }) + "\n",
  );
} else if (command === "prepare") {
  const target = spec.targets.find((entry) => entry.id === process.env.HANDOFF_EVIDENCE_TARGET);
  if (!target || target.source !== process.env.HANDOFF_EVIDENCE_SOURCE)
    throw new Error("Unexpected evidence source.");
  const sourceFiles = assertSource(target);
  const driverFiles = assertDriver();
  const { original, observed, main } = observedFixture();
  const sourceFixture = readFileSync(resolve(root, spec.fixture.path), "utf8");
  if (sourceFixture !== (target.variant === "before" ? main : original))
    throw new Error("The source test file does not match its pinned canonical identity.");
  for (const path of [fixturePath, configPath])
    if (existsSync(resolve(root, path)) || git(root, "ls-files", "--", path))
      throw new Error("Refusing to replace an existing path: " + path);
  const output = resolve(root, "pr-handoff-evidence", target.id);
  if (existsSync(output)) throw new Error("Evidence output already exists.");
  const temporary = process.env.RUNNER_TEMP;
  if (!temporary || !isAbsolute(temporary))
    throw new Error("Expected runner-owned temporary root.");
  const liveDirectory = resolve(temporary, "handoff-evidence-live-" + target.id);
  if (existsSync(liveDirectory)) throw new Error("Live report output already exists.");
  mkdirSync(liveDirectory);
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(root, fixturePath), observed);
  copyFileSync(resolve(directory, "vitest.handoff-evidence.config.ts"), resolve(root, configPath));
  writeFileSync(resolve(output, "source-ChatView.browser.tsx"), sourceFixture);
  writeFileSync(resolve(output, "common-canonical-ChatView.browser.tsx"), original);
  writeFileSync(resolve(output, "observed-ChatView.browser.tsx"), observed);
  copyFileSync(resolve(directory, "overlay.json"), resolve(output, "overlay.json"));
  const manifest = {
    target,
    source: target.source,
    sourceTree: target.tree,
    driver: git(driverRoot, "rev-parse", "HEAD"),
    driverTree: git(driverRoot, "rev-parse", "HEAD^{tree}"),
    driverFiles,
    sourceFiles,
    overlays: [fixturePath, configPath].map((path) => ({
      path,
      sha256: digest(readFileSync(resolve(root, path))),
    })),
    commonFixture: spec.fixture,
    mainFixture: spec.beforeFixture,
    newCasesOnlyComparedWithMain: true,
    originalAssertionsPreserved: true,
    applicationCodeModified: false,
    liveReport: resolve(liveDirectory, "vitest.json"),
    qualification:
      "Actual full production Router/ChatView/composer/theme under the same controlled orchestration snapshots and synthetic draft. Two complete canonical regression cases are selected; other cases are filtered and are not passing evidence. No authenticated provider, native CLI, desktop or OS behavior is exercised. Before failures remain failed steps; only observed media is retained.",
    run: process.env.GITHUB_RUN_ID,
    status: "prepared",
  };
  writeFileSync(resolve(output, "provenance.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (!process.env.GITHUB_ENV) throw new Error("Missing GitHub environment output.");
  appendFileSync(
    process.env.GITHUB_ENV,
    "VITE_HANDOFF_EVIDENCE_OUTPUT=" +
      output +
      "\n" +
      "VITE_HANDOFF_EVIDENCE_SOURCE=" +
      target.source +
      "\n" +
      "VITE_HANDOFF_EVIDENCE_VARIANT=" +
      target.variant +
      "\n" +
      "HANDOFF_EVIDENCE_LIVE_REPORT=" +
      manifest.liveReport +
      "\n",
  );
  console.log(
    JSON.stringify({ target, driver: manifest.driver, originalAssertionsPreserved: true }),
  );
} else if (command === "verify") {
  const output = process.env.VITE_HANDOFF_EVIDENCE_OUTPUT;
  if (!output || !output.startsWith(resolve(root, "pr-handoff-evidence") + "/"))
    throw new Error("Unexpected evidence output directory.");
  const manifest = JSON.parse(readFileSync(resolve(output, "provenance.json"), "utf8"));
  if (
    JSON.stringify(assertSource(manifest.target)) !== JSON.stringify(manifest.sourceFiles) ||
    JSON.stringify(assertDriver()) !== JSON.stringify(manifest.driverFiles)
  )
    throw new Error("Source or driver changed during execution.");
  for (const entry of manifest.overlays)
    if (digest(readFileSync(resolve(root, entry.path))) !== entry.sha256)
      throw new Error("Observed fixture/config changed during execution.");
  const exits = JSON.parse(readFileSync(resolve(output, "exits.json"), "utf8"));
  if (
    Object.keys(exits).sort().join(",") !== "tee,vitest" ||
    Object.values(exits).some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    throw new Error("Invalid actual command/tee exit receipt.");
  const errors = [];
  let report = null;
  const reportCapture = {
    source: manifest.liveReport,
    capturedAt: new Date().toISOString(),
    exists: false,
  };
  const reportPath = resolve(output, "vitest.json");
  if (existsSync(reportPath)) throw new Error("Refusing to overwrite a retained report snapshot.");
  if (existsSync(manifest.liveReport)) {
    const bytes = readFileSync(manifest.liveReport);
    writeFileSync(reportPath, bytes);
    Object.assign(reportCapture, { exists: true, bytes: bytes.length, sha256: digest(bytes) });
    try {
      report = JSON.parse(bytes.toString("utf8"));
    } catch {
      errors.push("The observed original report is invalid JSON.");
    }
  } else errors.push("The original report is missing.");
  writeFileSync(
    resolve(output, "report-snapshot.json"),
    JSON.stringify(reportCapture, null, 2) + "\n",
  );
  const log = readFileSync(resolve(output, "vitest.log"), "utf8");
  const prefix = "HANDOFF_EVIDENCE_OBSERVATION ";
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
  const expected = ["completed", "failed"].flatMap((outcome) =>
    (manifest.target.variant === "after" ? ["pending", "settled"] : ["pending"]).flatMap((stage) =>
      ["desktop", "narrow"].map((view) => outcome + "-" + stage + "-" + view),
    ),
  );
  if (new Set(phases).size !== phases.length || phases.some((phase) => !expected.includes(phase)))
    errors.push("Unexpected or duplicate observation phase.");
  for (const observed of observations) {
    const width = observed.phase.endsWith("-desktop") ? 960 : 480;
    const height = width === 960 ? 1100 : 640;
    if (
      observed.source !== manifest.source ||
      observed.variant !== manifest.target.variant ||
      observed.viewport.width !== width ||
      observed.viewport.height !== height ||
      observed.fonts !== "loaded" ||
      !observed.backgroundToken ||
      observed.reducedMotion !== true ||
      observed.documentWidth > width ||
      !observed.editor.text.includes("Keep this draft while the provider changes.")
    )
      errors.push("Observed source/layout/font/draft differs from the reviewed target.");
  }
  const files = inventory(output);
  const pngs = files.filter((entry) => entry.path.endsWith(".png") && !entry.path.includes("/"));
  for (const file of pngs) {
    const bytes = readFileSync(resolve(output, file.path));
    const width = file.path.endsWith("-desktop.png") ? 960 : 480;
    if (
      !expected.some((phase) => file.path === phase + ".png") ||
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(16) !== width ||
      bytes.readUInt32BE(20) !== (width === 960 ? 1100 : 640)
    )
      errors.push("Unexpected or invalid viewport PNG: " + file.path);
  }
  const videos = files.filter(
    (entry) => entry.path.startsWith("video/") && entry.path.endsWith(".webm"),
  );
  for (const file of videos)
    if (readFileSync(resolve(output, file.path)).subarray(0, 4).toString("hex") !== "1a45dfa3")
      errors.push("Invalid context video: " + file.path);
  const assertions = report?.testResults?.flatMap((file) => file.assertionResults ?? []) ?? [];
  const selected = assertions.filter((test) =>
    new RegExp(spec.testNamePattern).test(test.fullName ?? ""),
  );
  if (
    selected.length !== 2 ||
    selected.some((test) => !["passed", "failed"].includes(test.status)) ||
    assertions.some((test) => !selected.includes(test) && test.status !== "pending")
  )
    errors.push("Exactly the two original cases must execute; other cases must remain filtered.");
  if (
    phases.length !== expected.length ||
    pngs.length !== expected.length ||
    expected.some((phase) => !pngs.some((file) => file.path === phase + ".png")) ||
    videos.length !== 1
  )
    errors.push("Incomplete expected phase images or context video.");
  if (
    manifest.target.variant === "after" &&
    (selected.some((test) => test.status !== "passed") ||
      report?.numPassedTests !== 2 ||
      report?.numFailedTests !== 0)
  )
    errors.push("Both unchanged repaired-source cases must pass.");
  const actualExitCode = exits.vitest || exits.tee;
  const result = {
    ...manifest,
    status: actualExitCode || errors.length ? "failed" : "completed",
    actualExitCode,
    exits,
    verificationErrors: errors,
    reportSnapshot: reportCapture,
    selectedTests: selected.map(({ fullName, status, failureMessages }) => ({
      fullName,
      status,
      failureMessages,
    })),
    filteredTests: report?.numPendingTests ?? null,
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
      source: manifest.source,
      actualExitCode,
      errors,
      selected: result.selectedTests,
      filteredTests: result.filteredTests,
      phases,
    }),
  );
  if (actualExitCode || errors.length) process.exitCode = actualExitCode || 1;
} else throw new Error("Use matrix, prepare or verify.");

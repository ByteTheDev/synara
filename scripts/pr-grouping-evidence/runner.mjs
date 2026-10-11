import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const driver = dirname(fileURLToPath(import.meta.url));
const driverRoot = resolve(driver, "../..");
const targets = JSON.parse(readFileSync(resolve(driver, "targets.json"), "utf8"));
const spec = JSON.parse(readFileSync(resolve(driver, "observer.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fixturePath = "apps/web/src/components/PrUiEvidence1827ChatView.browser.tsx";
const configPath = "apps/web/vitest.pr-grouping-evidence.config.ts";

if (
  targets.length !== 2 ||
  new Set(targets.map(({ id }) => id)).size !== 2 ||
  targets.some(
    (target) =>
      !/^pr1827-(before|after)$/.test(target.id) ||
      !target.id.endsWith(`-${target.variant}`) ||
      !/^[a-f0-9]{40}$/.test(target.source) ||
      !/^[a-f0-9]{40}$/.test(target.tree),
  )
) {
  throw new Error("Exactly two reviewed grouping source targets are required.");
}

function assertSource(target) {
  if (
    git(root, "rev-parse", "HEAD") !== target.source ||
    git(root, "rev-parse", "HEAD^{tree}") !== target.tree ||
    git(root, "diff", "HEAD", "--name-only")
  ) {
    throw new Error("The entire tracked application must stay at its exact clean source head.");
  }
}

function assertDriver() {
  if (git(driverRoot, "diff", "HEAD", "--name-only"))
    throw new Error("Driver checkout is modified.");
  if (git(driverRoot, "rev-parse", `HEAD:${spec.fixture.path}`) !== spec.fixture.blob)
    throw new Error("Driver no longer contains the reviewed common fixture.");
  const original = readFileSync(resolve(driverRoot, spec.fixture.path), "utf8");
  if (digest(original) !== spec.fixture.sha256) throw new Error("Common fixture bytes changed.");
  return original;
}

const command = process.argv[2];
if (command === "matrix") {
  if (!process.env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: targets })}\n`);
} else if (command === "prepare") {
  const target = targets.find(({ id }) => id === process.env.PR_GROUPING_TARGET);
  if (!target || target.source !== process.env.PR_GROUPING_SOURCE)
    throw new Error("Unexpected target.");
  assertSource(target);
  const original = assertDriver();
  let observed = original;
  for (const entry of spec.cases) {
    const start = observed.indexOf(entry.start);
    const end = observed.indexOf(entry.end, start + entry.start.length);
    if (start < 0 || end < start || observed.indexOf(entry.start, start + 1) !== -1)
      throw new Error("Unknown original test boundary.");
    let section = observed.slice(start, end);
    for (const { before, after } of entry.replacements) {
      if (!after.includes(before) || section.split(before).length !== 2)
        throw new Error("Only a unique additive observation is permitted.");
      section = section.replace(before, after);
    }
    observed = observed.slice(0, start) + section + observed.slice(end);
  }
  const first = spec.cases[0].start;
  if (observed.split(first).length !== 2) throw new Error("The helper insertion must be unique.");
  observed = observed.replace(
    first,
    readFileSync(resolve(driver, "observer-helper.ts"), "utf8") + "\n" + first,
  );
  for (const path of [fixturePath, configPath]) {
    if (existsSync(resolve(root, path)) || git(root, "ls-files", "--", path))
      throw new Error(`Refusing to replace ${path}`);
  }
  writeFileSync(resolve(root, fixturePath), observed);
  copyFileSync(resolve(driver, "vitest.pr-grouping-evidence.config.ts"), resolve(root, configPath));
  const output = resolve(root, ".pr-grouping-evidence", target.id);
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, "original-ChatView.browser.tsx"), original);
  writeFileSync(resolve(output, "observed-ChatView.browser.tsx"), observed);
  copyFileSync(resolve(driver, "observer.json"), resolve(output, "observer.json"));
  const sourceFiles = [
    spec.fixture.path,
    "apps/web/src/components/Sidebar.tsx",
    "apps/web/src/components/Sidebar.uiState.ts",
    "apps/web/src/components/SidebarActivityView.tsx",
    "apps/web/src/hooks/useTheme.ts",
    "apps/web/src/index.css",
  ].map((path) => ({
    path,
    blob: git(root, "rev-parse", `HEAD:${path}`),
    sha256: digest(readFileSync(resolve(root, path))),
  }));
  const overlays = [fixturePath, configPath].map((path) => ({
    path,
    sha256: digest(readFileSync(resolve(root, path))),
  }));
  const manifest = {
    target,
    source: target.source,
    sourceTree: target.tree,
    driver: git(driverRoot, "rev-parse", "HEAD"),
    commonFixture: spec.fixture,
    sourceFiles,
    overlays,
    observerSha256: digest(readFileSync(resolve(driver, "observer.json"))),
    helperSha256: digest(readFileSync(resolve(driver, "observer-helper.ts"))),
    applicationCodeModified: false,
    originalAssertionsAndInteractionsPreserved: true,
    qualification:
      "Actual full ChatView, Sidebar, activity list, CSS and theme under the canonical MSW/orchestration fixtures. Same original two test cases on both sources, with additive observations before their assertions. Explicit test-dispatched external storage event; no native desktop or live account claim.",
    status: "prepared",
  };
  writeFileSync(resolve(output, "provenance.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required.");
  appendFileSync(
    process.env.GITHUB_ENV,
    `VITE_PR_GROUPING_OUTPUT=${output}\nVITE_PR_GROUPING_VARIANT=${target.variant}\nVITE_PR_GROUPING_SOURCE=${target.source}\n`,
  );
  console.log(JSON.stringify(manifest));
} else if (command === "verify") {
  const output = process.env.VITE_PR_GROUPING_OUTPUT;
  if (!output?.startsWith(resolve(root, ".pr-grouping-evidence") + "/"))
    throw new Error("Unexpected output directory.");
  const manifestPath = resolve(output, "provenance.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assertSource(manifest.target);
  assertDriver();
  for (const entry of [...manifest.sourceFiles, ...manifest.overlays]) {
    if (digest(readFileSync(resolve(root, entry.path))) !== entry.sha256)
      throw new Error(`File changed during execution: ${entry.path}`);
  }
  const exits = JSON.parse(readFileSync(resolve(output, "exits.json"), "utf8"));
  if (
    Object.keys(exits).toSorted().join(",") !== "tee,vitest" ||
    Object.values(exits).some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    throw new Error("Invalid actual exit receipt.");
  const log = readFileSync(resolve(output, "vitest.log"), "utf8");
  const prefix = "PR_GROUPING_OBSERVATION ";
  const observations = log
    .split("\n")
    .filter((line) => line.includes(prefix))
    .map((line) =>
      line
        .slice(line.indexOf(prefix) + prefix.length)
        .replace(/\x1b\[[0-9;]*m/g, "")
        .trim(),
    )
    .filter((payload) => payload.startsWith("{"))
    .map((payload) => JSON.parse(payload));
  const reportPath = resolve(output, "vitest.json");
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, "utf8")) : null;
  const results = report?.testResults?.flatMap((file) => file.assertionResults ?? []) ?? [];
  const selected = results.filter((test) =>
    spec.cases.some(({ name }) => test.fullName?.endsWith(name)),
  );
  const errors = [];
  const phases = observations.map(({ phase }) => phase);
  if (
    new Set(phases).size !== phases.length ||
    phases.some((phase) => !spec.expectedPhases.includes(phase))
  )
    errors.push("Unexpected or duplicate observation phase.");
  if (
    observations.some(
      (entry) =>
        entry.variant !== manifest.target.variant ||
        entry.source !== manifest.source ||
        entry.viewport.width !== 960 ||
        entry.viewport.height !== 1100,
    )
  )
    errors.push("Wrong observed source or viewport.");
  const files = [];
  const pngs = readdirSync(output).filter((name) => name.endsWith(".png"));
  for (const path of pngs) {
    const bytes = readFileSync(resolve(output, path));
    if (
      bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(16) !== 960 ||
      bytes.readUInt32BE(20) !== 1100
    )
      errors.push(`Invalid full-viewport PNG: ${path}`);
    files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  const videoDirectory = resolve(output, "video");
  const videos = existsSync(videoDirectory)
    ? readdirSync(videoDirectory).filter((name) => name.endsWith(".webm"))
    : [];
  for (const name of videos) {
    const bytes = readFileSync(resolve(videoDirectory, name));
    if (bytes.subarray(0, 4).toString("hex") !== "1a45dfa3") errors.push(`Invalid WebM: ${name}`);
    files.push({ path: `video/${name}`, bytes: bytes.length, sha256: digest(bytes) });
  }
  if (exits.vitest === 0) {
    if (
      selected.length !== 2 ||
      selected.some((test) => test.status !== "passed") ||
      report?.numFailedTests !== 0 ||
      report?.numPassedTests !== 2
    )
      errors.push("Both original grouping cases must pass; filtered cases are not passes.");
    if (
      phases.length !== 7 ||
      pngs.length !== 7 ||
      spec.expectedPhases.some((phase) => !pngs.includes(`${phase}.png`))
    )
      errors.push("Missing complete seven-phase evidence.");
    if (videos.length !== 1) errors.push("Expected exactly one complete context recording.");
  }
  const actualExitCode = exits.vitest || exits.tee;
  const result = {
    ...manifest,
    status: actualExitCode || errors.length ? "failed" : "completed",
    actualExitCode,
    exits,
    verificationErrors: errors,
    logSha256: digest(log),
    reportSha256: report ? digest(readFileSync(reportPath)) : null,
    selectedTests: selected.map(({ fullName, status, failureMessages }) => ({
      fullName,
      status,
      failureMessages,
    })),
    filteredTests: results.filter((test) => test.status === "pending").length,
    observations,
    files,
  };
  writeFileSync(manifestPath, JSON.stringify(result, null, 2) + "\n");
  console.log(
    JSON.stringify({
      source: manifest.source,
      actualExitCode,
      verificationErrors: errors,
      selectedTests: result.selectedTests,
      files,
    }),
  );
  if (actualExitCode || errors.length) process.exitCode = actualExitCode || 1;
} else throw new Error("Use matrix, prepare or verify.");

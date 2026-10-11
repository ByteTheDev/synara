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
const spec = JSON.parse(readFileSync(resolve(driver, "overlay.json"), "utf8"));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const fixturePath = "apps/web/src/components/PrUiEvidence1713CurrentChatView.browser.tsx";
const configPath = "apps/web/vitest.pr-retention-cache-evidence.config.ts";

if (
  targets.length !== 2 ||
  new Set(targets.map(({ id }) => id)).size !== 2 ||
  targets.some(
    (target) =>
      !/^pr1713-current-(before|after)$/.test(target.id) ||
      !target.id.endsWith(`-${target.variant}`) ||
      !/^[a-f0-9]{40}$/.test(target.source) ||
      !/^[a-f0-9]{40}$/.test(target.tree),
  )
) {
  throw new Error("Exactly two reviewed retention/cache source targets are required.");
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
  const target = targets.find(({ id }) => id === process.env.PR_RETENTION_TARGET);
  if (!target || target.source !== process.env.PR_RETENTION_SOURCE)
    throw new Error("Unexpected target.");
  assertSource(target);
  const original = assertDriver();
  let observed = original;
  for (const { before, after } of spec.replacements) {
    if (observed.split(before).length !== 2)
      throw new Error("Expected one reviewed fixture setup boundary.");
    observed = observed.replace(before, after);
  }
  const helpers = readFileSync(resolve(driver, "fixture-helpers.ts"), "utf8") + "\n";
  const cases =
    readFileSync(resolve(driver, "fixture-cases.ts"), "utf8")
      .split("\n")
      .map((line) => (line ? "  " + line : line))
      .join("\n") + "\n";
  if (
    observed.split(spec.helperAnchor).length !== 2 ||
    observed.split(spec.caseAnchor).length !== 2
  )
    throw new Error("Expected unique helper and case boundaries.");
  observed = observed.replace(spec.helperAnchor, helpers + spec.helperAnchor);
  observed = observed.replace(spec.caseAnchor, cases + spec.caseAnchor);
  let recovered = observed.replace(helpers, "").replace(cases, "");
  for (const { before, after } of [...spec.replacements].reverse())
    recovered = recovered.replace(after, before);
  if (recovered !== original) throw new Error("The original complete common fixture was changed.");
  for (const path of [fixturePath, configPath]) {
    if (existsSync(resolve(root, path)) || git(root, "ls-files", "--", path))
      throw new Error(`Refusing to replace ${path}`);
  }
  writeFileSync(resolve(root, fixturePath), observed);
  copyFileSync(
    resolve(driver, "vitest.pr-retention-cache-evidence.config.ts"),
    resolve(root, configPath),
  );
  const output = resolve(root, ".pr-retention-cache-evidence", target.id);
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, "original-ChatView.browser.tsx"), original);
  writeFileSync(resolve(output, "observed-ChatView.browser.tsx"), observed);
  copyFileSync(resolve(driver, "overlay.json"), resolve(output, "overlay.json"));
  const sourceFiles = [
    spec.fixture.path,
    "apps/web/src/components/ChatView.tsx",
    "apps/web/src/components/chat/ComposerClaudeCacheReviewPanel.tsx",
    "apps/web/src/components/chat/ComposerChoiceRow.tsx",
    "apps/web/src/components/chat/composerPickerStyles.ts",
    "apps/web/src/components/ui/toast.tsx",
    "apps/web/src/components/settings/ProvidersSettingsPanel.tsx",
    "apps/web/src/routes/_chat.settings.tsx",
    "apps/web/src/appSettings.ts",
    "apps/web/src/settingsSearchIndex.ts",
    "apps/web/src/wsNativeApi.ts",
    "apps/web/src/hooks/useTheme.ts",
    "apps/web/src/index.css",
    "apps/server/src/threadRetention.ts",
    "apps/server/src/orchestration/Layers/ProviderCommandReactor.ts",
    "packages/contracts/src/settings.ts",
    "packages/shared/src/claudeCache.ts",
    "package.json",
    "apps/web/package.json",
    "apps/server/package.json",
    "packages/contracts/package.json",
    "packages/shared/package.json",
    "bun.lock",
    ".github/actions/setup-workspace/action.yml",
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
    observerSha256: digest(readFileSync(resolve(driver, "overlay.json"))),
    helperSha256: digest(readFileSync(resolve(driver, "fixture-helpers.ts"))),
    casesSha256: digest(readFileSync(resolve(driver, "fixture-cases.ts"))),
    applicationCodeModified: false,
    originalCommonFixturePreserved: true,
    qualification:
      "Actual full ChatView, Settings route, provider control, cache panel and toast under the canonical MSW/orchestration fixture. Three identical added tests run on both sources. Saved settings, a pending cache assessment, response acknowledgement and failed settings RPC are controlled boundaries. The real ChatView response callback, app-settings write queue and toast render without component/hook/geometry mocks. No live Claude request, actual settings-file persistence, native provider cleanup or retention sweep is claimed.",
    status: "prepared",
  };
  writeFileSync(resolve(output, "provenance.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is required.");
  appendFileSync(
    process.env.GITHUB_ENV,
    `VITE_PR_RETENTION_OUTPUT=${output}\nVITE_PR_RETENTION_VARIANT=${target.variant}\nVITE_PR_RETENTION_SOURCE=${target.source}\n`,
  );
  console.log(JSON.stringify(manifest));
} else if (command === "verify") {
  const output = process.env.VITE_PR_RETENTION_OUTPUT;
  if (!output?.startsWith(resolve(root, ".pr-retention-cache-evidence") + "/"))
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
  const prefix = "PR_RETENTION_OBSERVATION ";
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
      selected.length !== spec.cases.length ||
      selected.some((test) => test.status !== "passed") ||
      report?.numFailedTests !== 0 ||
      report?.numPassedTests !== spec.cases.length
    )
      errors.push(
        "All three full-ChatView retention/cache cases must pass; filtered cases are not passes.",
      );
    if (
      phases.length !== spec.expectedPhases.length ||
      pngs.length !== spec.expectedPhases.length ||
      spec.expectedPhases.some((phase) => !pngs.includes(`${phase}.png`))
    )
      errors.push("Missing complete nine-phase evidence.");
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
    unselectedTests: report?.numPendingTests ?? null,
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

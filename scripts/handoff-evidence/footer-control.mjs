import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedStableRead, freezeDirectory, freezeFile } from "./snapshots.mjs";

const root = process.cwd();
const directory = dirname(fileURLToPath(import.meta.url));
const driverRoot = resolve(directory, "../..");
const targets = {
  before: {
    source: "53248e7ed92a1d14147cd66822cfa982b0d6baef",
    tree: "c22c3af445bd06fb427814cf5a7428eec25a2edd",
  },
  after: {
    source: "2a53c3c7c20e6aec90f6eaf3067d292955d2686e",
    tree: "4505c81b9128f56a758708c0581106490b3a5859",
  },
};
const variant = process.env.HANDOFF_FOOTER_TARGET;
const target = targets[variant];
if (!target) throw new Error("A reviewed Before or After footer target is required.");
const commonPath = "apps/web/src/components/chat/ChatComposerFooter.browser.tsx";
const fixturePath = "apps/web/src/components/chat/PrHandoffFooterControl1145.browser.tsx";
const configPath = "apps/web/vitest.handoff-footer.config.ts";
const liveScreenshots = resolve(
  root,
  "apps/web/src/components/chat/__screenshots__/PrHandoffFooterControl1145.browser.tsx",
);
const output = resolve(root, "pr-handoff-footer-evidence", variant);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const blob = (bytes) =>
  createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 }).trim();
const sourcePaths = [
  commonPath,
  "apps/web/src/components/chat/ChatComposerFooter.tsx",
  "apps/web/src/components/ChatView.tsx",
  "bun.lock",
];
const driverPaths = [
  ".github/workflows/handoff-evidence.yml",
  ...[
    "runner.mjs",
    "snapshots.mjs",
    "helpers.ts",
    "overlay.json",
    "footer-control.mjs",
    "vitest.handoff-footer.config.ts",
    "vitest.handoff-evidence.config.ts",
    "README.md",
  ].map((name) => "scripts/handoff-evidence/" + name),
];

function fileProof(cwd, path) {
  const bytes = readFileSync(resolve(cwd, path));
  const expected = git(cwd, "rev-parse", "HEAD:" + path);
  if (blob(bytes) !== expected) throw new Error("Tracked file changed: " + path);
  return { path, bytes: bytes.length, blob: expected, sha256: sha256(bytes) };
}
function assertSource() {
  if (
    git(root, "rev-parse", "HEAD") !== target.source ||
    git(root, "rev-parse", "HEAD^{tree}") !== target.tree ||
    git(root, "diff", "--exit-code", "HEAD", "--name-only")
  )
    throw new Error("The complete application source must remain at the exact reviewed head.");
  return sourcePaths.map((path) => fileProof(root, path));
}
function inventory(path, prefix = "") {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isSymbolicLink()) throw new Error("Unexpected artifact link.");
    const relative = prefix + entry.name;
    if (entry.isDirectory()) return inventory(resolve(path, entry.name), relative + "/");
    if (!entry.isFile()) throw new Error("Unexpected artifact type.");
    const bytes = boundedStableRead(resolve(path, entry.name), 40 * 1024 * 1024).bytes;
    return [{ path: relative, bytes: bytes.length, sha256: sha256(bytes), blob: blob(bytes) }];
  });
}

const command = process.argv[2];
if (command === "prepare") {
  const sourceFiles = assertSource();
  if (git(driverRoot, "diff", "--exit-code", "HEAD", "--name-only"))
    throw new Error("Driver source changed.");
  const driverFiles = driverPaths.map((path) => fileProof(driverRoot, path));
  const canonical = fileProof(driverRoot, commonPath);
  if (canonical.blob !== "51fe0dac36f1a7458b922c734b5704114eabf6f8")
    throw new Error("The complete six-case common fixture changed.");
  const fixture = readFileSync(resolve(driverRoot, commonPath));
  const config = readFileSync(resolve(directory, "vitest.handoff-footer.config.ts"));
  for (const path of [fixturePath, configPath]) {
    if (existsSync(resolve(root, path)) || git(root, "ls-files", "--", path))
      throw new Error("Refusing to replace existing input: " + path);
  }
  if (existsSync(output) || existsSync(liveScreenshots))
    throw new Error("Stale footer evidence exists.");
  const temporary = process.env.RUNNER_TEMP;
  if (!temporary || !isAbsolute(temporary))
    throw new Error("A runner-owned temporary root is required.");
  const live = resolve(temporary, "handoff-footer-live-" + variant);
  if (existsSync(live)) throw new Error("Stale live footer output exists.");
  mkdirSync(live);
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(root, fixturePath), fixture);
  writeFileSync(resolve(root, configPath), config);
  writeFileSync(resolve(output, "common-canonical-ChatComposerFooter.browser.tsx"), fixture);
  writeFileSync(
    resolve(output, "source-ChatComposerFooter.tsx"),
    readFileSync(resolve(root, sourcePaths[1])),
  );
  const manifest = {
    variant,
    ...target,
    driver: git(driverRoot, "rev-parse", "HEAD"),
    driverTree: git(driverRoot, "rev-parse", "HEAD^{tree}"),
    driverFiles,
    sourceFiles,
    canonical,
    overlays: [
      { path: fixturePath, sha256: sha256(fixture) },
      { path: configPath, sha256: sha256(config) },
    ],
    live,
    liveScreenshots,
    qualification:
      "The identical complete six-case footer fixture runs on both production implementations. Three existing Stop/voice cases and three explicit pending-to-settled cases execute without name filtering. Before receives the new handoffPending input that its unchanged component ignores. No provider, native desktop or OS behavior is exercised; original failed browser exits remain failures.",
  };
  writeFileSync(resolve(output, "provenance.json"), JSON.stringify(manifest, null, 2) + "\n");
  if (!process.env.GITHUB_ENV) throw new Error("Missing environment output.");
  appendFileSync(process.env.GITHUB_ENV, "HANDOFF_FOOTER_LIVE=" + live + "\n");
} else if (command === "verify") {
  const manifest = JSON.parse(readFileSync(resolve(output, "provenance.json"), "utf8"));
  const errors = [];
  const attempt = (label, run) => {
    try {
      return run();
    } catch (error) {
      errors.push(label + ": " + String(error));
      return null;
    }
  };
  const snapshots = [];
  for (const [name, limit] of [
    ["vitest.json", 20 * 1024 * 1024],
    ["vitest.log", 40 * 1024 * 1024],
    ["exits.json", 8 * 1024],
  ]) {
    attempt("Freeze " + name, () =>
      freezeFile(resolve(manifest.live, name), output, name, snapshots, limit),
    );
  }
  const failureScreenshots = [];
  if (existsSync(liveScreenshots))
    attempt("Freeze original failure screenshots", () =>
      freezeDirectory(
        liveScreenshots,
        resolve(output, "failure-screenshots"),
        failureScreenshots,
        60 * 1024 * 1024,
      ),
    );
  writeFileSync(
    resolve(output, "output-snapshots.json"),
    JSON.stringify(
      {
        snapshots,
        failureScreenshots,
        capturedAt: new Date().toISOString(),
        qualification:
          "One bounded stable copy precedes parsing and hashing. Later writer output cannot alter retained bytes; missing or changing files fail and no descendant-cleanup claim is made.",
      },
      null,
      2,
    ) + "\n",
  );
  for (const overlay of manifest.overlays) {
    if (sha256(readFileSync(resolve(root, overlay.path))) !== overlay.sha256)
      errors.push("Controlled input changed: " + overlay.path);
  }
  const read = (name, limit) =>
    JSON.parse(boundedStableRead(resolve(output, name), limit).bytes.toString("utf8"));
  const report = attempt("Read frozen report", () => read("vitest.json", 20 * 1024 * 1024));
  const exits = attempt("Read frozen actual exits", () => {
    const value = read("exits.json", 8 * 1024);
    if (
      Object.keys(value).sort().join(",") !== "tee,vitest" ||
      Object.values(value).some((value) => !Number.isInteger(value) || value < 0 || value > 255)
    )
      throw new Error("Invalid actual exit receipt.");
    return value;
  });
  const assertions = report?.testResults?.flatMap((file) => file.assertionResults ?? []) ?? [];
  const original = assertions.filter(
    (test) => !test.fullName.includes("holds handoff admission separately from"),
  );
  const pending = assertions.filter((test) =>
    test.fullName.includes("holds handoff admission separately from"),
  );
  if (
    assertions.length !== 6 ||
    original.length !== 3 ||
    pending.length !== 3 ||
    report?.numTotalTests !== 6 ||
    report?.numPendingTests !== 0 ||
    report?.numTodoTests !== 0
  )
    errors.push("All six canonical cases must execute; no filtering or skips are permitted.");
  if (original.some((test) => test.status !== "passed"))
    errors.push("An existing Stop/voice assertion failed.");
  const expectedStatus = variant === "before" ? "failed" : "passed";
  if (pending.some((test) => test.status !== expectedStatus))
    errors.push("Pending-to-settled control differs from the declared Before/After expectation.");
  if (
    variant === "before" &&
    pending.some(
      (test) => !(test.failureMessages ?? []).some((message) => message.includes("Connecting")),
    )
  )
    errors.push("Before did not fail at the missing held-submit control.");
  if (
    report?.numPassedTests !== (variant === "before" ? 3 : 6) ||
    report?.numFailedTests !== (variant === "before" ? 3 : 0)
  )
    errors.push("Unexpected canonical pass/fail counts.");
  const browserOutcome = process.env.HANDOFF_FOOTER_BROWSER_OUTCOME;
  const actualExitCode = exits === null ? null : exits.vitest || exits.tee;
  const failed = browserOutcome !== "success" || actualExitCode !== 0 || errors.length > 0;
  for (const overlay of manifest.overlays) rmSync(resolve(root, overlay.path));
  attempt("Recheck exact source", assertSource);
  writeFileSync(
    resolve(output, "verified.json"),
    JSON.stringify(
      {
        ...manifest,
        browserOutcome,
        actualExitCode,
        exits,
        errors,
        assertions,
        expectedControlMatched: errors.length === 0,
        status: failed || errors.length ? "failed" : "completed",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    resolve(output, "manifest.json"),
    JSON.stringify(inventory(output), null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      variant,
      source: target.source,
      actualExitCode,
      errors,
      passed: report?.numPassedTests,
      failed: report?.numFailedTests,
    }),
  );
  if (failed || errors.length) process.exitCode = actualExitCode || 1;
} else throw new Error("Use prepare or verify.");

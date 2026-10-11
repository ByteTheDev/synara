import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync,
  readFileSync, readdirSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const folder = dirname(fileURLToPath(import.meta.url));
const driver = resolve(folder, "../..");
const root = process.cwd();
const phase = process.argv[2];
const variant = process.env.RUNTIME_CHATVIEW_CASE;
const pins = {
  before: {
    source: "75ec05e69c819a57573a24be1a424f3e8420ebe8",
    tree: "833d32dfdc79af7a3e9d11f63924611e1d14dad7",
    hook: "1d4378e9fced76ff2a13431f437fe0bf951bdca3",
  },
  after: {
    source: "ab8a77a873e2443ffc9a9570cbd2919219fd41c9",
    tree: "cd1b99fed142f3d28cfa1aa93467f5f6b4d35c4f",
    hook: "1e67805a6037c8cd7728919da35cc7530b69ad73",
  },
}[variant];
assert.ok(pins, "Only the reviewed Before/After comparison is supported");
assert.equal(process.env.RUNTIME_CHATVIEW_SOURCE, pins.source);
assert.equal(process.platform, "linux");
assert.ok(process.env.RUNNER_TEMP?.startsWith("/"));
const output = join(process.env.RUNNER_TEMP, "chatview-scroll-evidence");
mkdirSync(output, { recursive: true });
const destination = "apps/web/src/components/ChatView.browser.tsx";
const originalBlob = "73c366c47798f7b505ed3a1c293ae3b893953b5c";
const hook = "apps/web/src/components/chat/useChatTranscriptScroll.ts";
const config = "apps/web/vitest.runtime-chatview-evidence.config.ts";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const hash = path => digest(readFileSync(path));
const blob = path => {
  const bytes = readFileSync(path);
  return createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
};
const save = (name, value) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
function git(args, cwd = root) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false, timeout: 30_000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}
function guard(prepared) {
  assert.equal(git(["rev-parse", "HEAD"]), pins.source);
  assert.equal(git(["rev-parse", "HEAD^{tree}"]), pins.tree);
  assert.equal(git(["rev-parse", "HEAD"], driver), process.env.GITHUB_SHA);
  assert.equal(git(["diff", "--exit-code", "HEAD", "--"], driver), "");
  assert.equal(blob(join(root, hook)), pins.hook);
  assert.deepEqual(
    git(["diff", "--name-only", "HEAD", "--"]).split("\n").filter(Boolean).sort(),
    prepared ? [destination] : [],
  );
  if (!prepared) assert.equal(blob(join(root, destination)), originalBlob);
  else {
    const manifest = JSON.parse(readFileSync(join(output, "provenance.json"), "utf8"));
    assert.equal(manifest.source, pins.source);
    assert.equal(manifest.driver, process.env.GITHUB_SHA);
    for (const item of manifest.overlays) assert.equal(hash(join(root, item.path)), item.sha256);
  }
}
function prepare() {
  guard(false);
  const original = readFileSync(join(root, destination), "utf8");
  const fixture = readFileSync(join(folder, "fixture.snippet.ts"), "utf8");
  assert.ok(original.endsWith("\n});\n"), "The canonical outer describe boundary changed");
  assert.ok(!original.includes("PR UI evidence: preserve a ChatView reading position"));
  assert.equal(existsSync(join(root, config)), false, "Never replace an existing config");
  writeFileSync(join(root, destination), original.slice(0, -5) + "\n" + fixture + "\n});\n");
  copyFileSync(join(folder, "vitest.runtime-chatview-evidence.config.ts"), join(root, config));
  save("provenance.json", {
    source: pins.source,
    sourceTree: pins.tree,
    driver: process.env.GITHUB_SHA,
    driverTree: git(["rev-parse", "HEAD^{tree}"], driver),
    variant,
    hookBlob: pins.hook,
    originalChatViewTestBlob: originalBlob,
    fixtureSha256: digest(fixture),
    originalChatViewTestSha256: digest(original),
    driverScriptSha256: hash(fileURLToPath(import.meta.url)),
    driverWorkflowSha256: hash(join(driver, ".github/workflows/runtime-chatview-evidence.yml")),
    lockfileSha256: hash(join(root, "bun.lock")),
    overlays: [destination, config].map(path => ({ path, sha256: hash(join(root, path)) })),
    applicationCodeModified: false,
    qualification: "Actual ChatView, production CSS/router/virtual list in hosted Chromium with native browser PageUp and wheel input; orchestration and native API remain canonical fixtures. Both ordinary full-component cases must pass on both heads. No forced scroll dimensions, replaced hooks, native Electron/macOS input, authenticated provider or compensation-race reproduction claim. The separate unchanged ten-test control at run38153628677 retains its Before1-fail/9-pass and After10-pass causal evidence.",
    status: "prepared",
  });
  guard(true);
  for (const [key, value] of Object.entries({
    VITE_PR_CHATVIEW_VARIANT: variant,
    VITE_PR_CHATVIEW_OUTPUT: output,
  })) {
    assert.ok(!/[\r\n]/.test(value));
    appendFileSync(process.env.GITHUB_ENV, key + "=" + value + "\n");
  }
}
function execute() {
  guard(true);
  const args = [
    "x", "vitest", "run", "--config", "vitest.runtime-chatview-evidence.config.ts",
    "--reporter=default", "--reporter=json", "--outputFile=" + join(output, "vitest.json"),
  ];
  const fd = openSync(join(output, "vitest.log"), "w");
  let result;
  try {
    result = spawnSync("bun", args, {
      cwd: join(root, "apps/web"), shell: false, stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
  process.stdout.write(readFileSync(join(output, "vitest.log")));
  save("actual-result.json", {
    source: pins.source, driver: process.env.GITHUB_SHA, command: "bun", args,
    status: result.status, signal: result.signal, error: result.error?.message ?? null,
    logSha256: hash(join(output, "vitest.log")),
  });
  guard(true);
  if (result.error || result.status !== 0 || result.signal !== null)
    process.exitCode = Number.isInteger(result.status) && result.status > 0 && result.status < 256
      ? result.status : 1;
}
function verify() {
  guard(true);
  const actual = JSON.parse(readFileSync(join(output, "actual-result.json"), "utf8"));
  const report = JSON.parse(readFileSync(join(output, "vitest.json"), "utf8"));
  assert.equal(actual.source, pins.source);
  assert.equal(actual.driver, process.env.GITHUB_SHA);
  assert.equal(actual.logSha256, hash(join(output, "vitest.log")));
  assert.equal(actual.status, 0, "Preserve the real failing test exit");
  assert.equal(actual.signal, null);
  assert.equal(actual.error, null);
  assert.equal(report.success, true);
  assert.equal(report.numFailedTests, 0);
  assert.equal(report.numPassedTests, 2);
  const tests = report.testResults.flatMap(file => file.assertionResults)
    .filter(test => test.fullName.includes("PR UI evidence: preserve a ChatView reading position"));
  assert.equal(tests.length, 2);
  for (const gesture of ["keyboard", "wheel"])
    assert.equal(tests.filter(test => test.status === "passed" && test.fullName.includes("after " + gesture + " input")).length, 1);
  const log = readFileSync(join(output, "vitest.log"), "utf8");
  const prefix = "PR_CHATVIEW_SCROLL_RESULT ";
  const observations = log.split("\n").filter(line => line.includes(prefix)).map(line =>
    JSON.parse(line.slice(line.indexOf(prefix) + prefix.length).replace(/\x1b\[[0-9;]*m/g, "").trim()),
  );
  assert.equal(observations.length, 2);
  const expectedNames = [];
  for (const gesture of ["keyboard", "wheel"]) {
    const matches = observations.filter(item => item.gesture === gesture && item.variant === variant);
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].states.map(state => state.name), [
      "following", "reading", "streaming-while-reading", "following-resumed",
    ]);
    for (const state of matches[0].states) expectedNames.push(gesture + "-" + state.name + ".png");
  }
  const pngs = readdirSync(output).filter(name => name.endsWith(".png")).sort();
  assert.deepEqual(pngs, expectedNames.sort());
  const images = pngs.map(name => {
    const bytes = readFileSync(join(output, name));
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(bytes.readUInt32BE(16), 1280);
    assert.equal(bytes.readUInt32BE(20), 900);
    return { name, bytes: bytes.length, sha256: digest(bytes), width: 1280, height: 900 };
  });
  const videoNames = readdirSync(join(output, "video")).filter(name => name.endsWith(".webm"));
  assert.equal(videoNames.length, 1, "Retain the entire single-context browser recording");
  const videos = videoNames.map(name => {
    const bytes = readFileSync(join(output, "video", name));
    assert.equal(bytes.subarray(0, 4).toString("hex"), "1a45dfa3");
    assert.ok(bytes.length > 1024);
    return { name: "video/" + name, bytes: bytes.length, sha256: digest(bytes) };
  });
  const manifest = JSON.parse(readFileSync(join(output, "provenance.json"), "utf8"));
  save("provenance.json", {
    ...manifest, status: "completed", actual, images, videos, observations,
    reportSha256: hash(join(output, "vitest.json")),
  });
  console.log(JSON.stringify({ source: pins.source, passed: 2, images: images.length, videos: videos.length }));
}
try {
  if (phase === "prepare") prepare();
  else if (phase === "execute") execute();
  else if (phase === "verify") verify();
  else throw new Error("Use prepare, execute or verify");
} catch (error) {
  save(phase + "-failure.json", { source: pins.source, driver: process.env.GITHUB_SHA, message: String(error), stack: error.stack });
  console.error(error);
  process.exitCode = 1;
}


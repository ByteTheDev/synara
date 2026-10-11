// Read published packages and hash their bytes. Do not extract, install or execute them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceHead = "392bc7e3614e35d59c42add5a1c1bf6f153dd76a";
const version = "2.0.25";
const helperPath = ".github/scripts/runtime-startup-native-metadata.mjs";
const workflowPath = ".github/workflows/runtime-startup-native-metadata.yml";
const output = process.env.SYNARA_METADATA_OUTPUT;
assert.ok(output, "A separate evidence directory is required");
assert.ok(process.env.RUNNER_TEMP, "This read-only diagnostic is intended for an isolated runner");
assert.ok(
  resolve(output).startsWith(resolve(process.env.RUNNER_TEMP) + "/"),
  "Evidence must remain inside the runner's temporary directory",
);
mkdirSync(output, { recursive: true });
const write = (name, value) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2) + "\n");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failures = [];

function sourceIntegrity(phase) {
  const commands = [
    ["rev-parse", "HEAD"],
    ["status", "--porcelain=v1", "--untracked-files=all"],
    ["diff", "--exit-code", sourceHead, "--", ".", `:!${helperPath}`, `:!${workflowPath}`],
  ];
  const results = commands.map((args) => {
    const result = spawnSync("git", args, {
      encoding: "utf8",
      shell: false,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return {
      args,
      status: result.status,
      signal: result.signal,
      error: result.error?.message ?? null,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  });
  write(`source-${phase}.json`, { sourceHead, driverHead: process.env.GITHUB_SHA, results });
  for (const result of results) {
    assert.equal(result.error, null);
    assert.equal(result.status, 0, JSON.stringify(result));
  }
  assert.equal(results[0].stdout.trim(), process.env.GITHUB_SHA);
  assert.equal(results[1].stdout.trim(), "", "Source checkout must remain clean");
  assert.equal(
    JSON.parse(readFileSync("apps/server/package.json", "utf8")).dependencies["@opencode/client"],
    version,
    "The selected CLI version must match the exact source's client version",
  );
}

async function readBounded(response, maximumBytes, onChunk) {
  assert.ok(response.body, "A response body is required");
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    assert.ok(bytes <= maximumBytes, `Response exceeded ${maximumBytes} bytes`);
    onChunk(chunk);
  }
  return bytes;
}

async function packageMetadata(platform) {
  // These exact scopes and fallback order come from https://opencode.ai/v2/install.
  // A different version is never substituted if the requested release is absent.
  for (const scope of ["@opencode", "@opencode-ai"]) {
    const name = `${scope}/cli-${platform}`;
    const url = `https://registry.npmjs.org/${encodeURIComponent(name)}/${version}`;
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
    const chunks = [];
    const bytes = await readBounded(response, 1024 * 1024, (chunk) => chunks.push(chunk));
    const raw = Buffer.concat(chunks);
    const receiptName = `${platform}-${scope.slice(1)}`;
    writeFileSync(join(output, `${receiptName}-metadata.txt`), raw);
    write(`${receiptName}-request.json`, {
      name,
      requestedVersion: version,
      url,
      status: response.status,
      bytes,
      sha256: sha256(raw),
      contentType: response.headers.get("content-type"),
    });
    if (response.status === 404) continue;
    assert.equal(response.status, 200, `${name}: registry metadata request failed`);
    const metadata = JSON.parse(raw.toString("utf8"));
    assert.equal(metadata.name, name);
    assert.equal(metadata.version, version);
    assert.equal(typeof metadata.dist?.tarball, "string");
    const tarball = new URL(metadata.dist.tarball);
    assert.equal(tarball.origin, "https://registry.npmjs.org");
    assert.equal(tarball.username, "");
    assert.equal(tarball.password, "");
    assert.equal(tarball.search, "");
    assert.equal(tarball.hash, "");
    assert.equal(decodeURIComponent(tarball.pathname), `/${name}/-/cli-${platform}-${version}.tgz`);
    assert.match(metadata.dist.shasum, /^[a-f0-9]{40}$/);
    assert.match(metadata.dist.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    return { metadata, metadataSha256: sha256(raw), metadataBytes: bytes, metadataUrl: url };
  }
  throw new Error(`Neither documented scope publishes cli-${platform}@${version}`);
}

async function inspect(platform) {
  console.log(`Reading exact published metadata for ${platform}@${version}`);
  const published = await packageMetadata(platform);
  const { metadata } = published;
  const receipt = {
    platform,
    name: metadata.name,
    version,
    metadataUrl: published.metadataUrl,
    metadataSha256: published.metadataSha256,
    metadataBytes: published.metadataBytes,
    publishedDist: metadata.dist,
    packageOs: metadata.os ?? null,
    packageCpu: metadata.cpu ?? null,
    download: null,
    verified: false,
  };
  write(`${platform}-integrity.json`, receipt);
  const startedAt = Date.now();
  const response = await fetch(metadata.dist.tarball, {
    redirect: "error",
    signal: AbortSignal.timeout(300_000),
  });
  const hashes = Object.fromEntries(
    ["sha1", "sha256", "sha512"].map((name) => [name, createHash(name)]),
  );
  const download = {
    status: response.status,
    contentLength: response.headers.get("content-length"),
    bytes: 0,
    elapsedMs: 0,
    sha1: null,
    sha256: null,
    sha512Base64: null,
    error: null,
  };
  receipt.download = download;
  try {
    assert.equal(response.status, 200, "Native archive download failed");
    const declaredLength = download.contentLength === null ? null : Number(download.contentLength);
    if (declaredLength !== null) {
      assert.ok(Number.isSafeInteger(declaredLength) && declaredLength > 0);
      assert.ok(
        declaredLength <= 512 * 1024 * 1024,
        "Native archive exceeds the finite size limit",
      );
    }
    download.bytes = await readBounded(response, 512 * 1024 * 1024, (chunk) => {
      download.bytes += chunk.byteLength;
      for (const hash of Object.values(hashes)) hash.update(chunk);
    });
    download.sha1 = hashes.sha1.digest("hex");
    download.sha256 = hashes.sha256.digest("hex");
    download.sha512Base64 = hashes.sha512.digest("base64");
    if (declaredLength !== null) assert.equal(download.bytes, declaredLength);
    assert.equal(download.sha1, metadata.dist.shasum);
    assert.equal(`sha512-${download.sha512Base64}`, metadata.dist.integrity);
    receipt.verified = true;
  } catch (error) {
    download.error = String(error);
    throw error;
  } finally {
    if (!receipt.verified) await response.body?.cancel().catch(() => undefined);
    download.elapsedMs = Date.now() - startedAt;
    write(`${platform}-integrity.json`, receipt);
  }
  console.log(`${metadata.name}@${version}: ${download.bytes} bytes verified; no binary execution`);
}

write("provenance.json", {
  driverHead: process.env.GITHUB_SHA,
  sourceHead,
  run: process.env.GITHUB_RUN_ID,
  helperSha256: sha256(readFileSync(fileURLToPath(import.meta.url))),
  workflowSha256: sha256(readFileSync(workflowPath)),
  requestedVersion: version,
  officialInstaller: "https://opencode.ai/v2/install",
  versionBasis: "Synara's exact feature source pins @opencode/client 2.0.25.",
  qualification:
    "Public registry metadata and complete archive hashing only. No extraction, installation, native binary execution, provider authentication, phase measurement or lease-sufficiency claim.",
});
try {
  sourceIntegrity("before");
  for (const platform of ["linux-x64", "windows-x64"]) {
    try {
      await inspect(platform);
    } catch (error) {
      failures.push({ platform, message: String(error), stack: error.stack });
      write("failures.json", failures);
      console.error(`${platform}: ${String(error)}`);
    }
  }
} catch (error) {
  failures.push({ phase: "source-before", message: String(error), stack: error.stack });
} finally {
  try {
    sourceIntegrity("after");
  } catch (error) {
    failures.push({ phase: "source-after", message: String(error), stack: error.stack });
  }
  write("result.json", { passed: failures.length === 0, failures });
  if (failures.length > 0) process.exitCode = 1;
}

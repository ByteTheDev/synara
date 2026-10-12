import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const state = (value) => ({
  size: value.size,
  mtimeMs: value.mtimeMs,
  ctimeMs: value.ctimeMs,
  dev: value.dev,
  ino: value.ino,
  mode: value.mode,
});

export function boundedStableRead(path, maxBytes) {
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > 0);
  const pathBefore = lstatSync(path);
  assert.ok(
    pathBefore.isFile() && !pathBefore.isSymbolicLink(),
    "A regular source file is required: " + path,
  );
  assert.ok(
    Number.isSafeInteger(pathBefore.size) && pathBefore.size >= 0 && pathBefore.size <= maxBytes,
    "Source exceeds its read bound: " + path,
  );
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    assert.ok(before.isFile());
    assert.deepEqual(state(before), state(pathBefore), "Source changed before opening: " + path);
    // Allocate only after the regular-file and size checks. Read at most the
    // declared size plus one byte, even if a late writer grows the source.
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, null);
      assert.ok(count > 0, "Source was truncated during snapshot: " + path);
      offset += count;
    }
    assert.equal(
      readSync(fd, Buffer.alloc(1), 0, 1, null),
      0,
      "Source grew during snapshot: " + path,
    );
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    assert.ok(pathAfter.isFile() && !pathAfter.isSymbolicLink());
    assert.deepEqual(state(after), state(before), "Source changed during snapshot: " + path);
    assert.deepEqual(
      state(pathAfter),
      state(before),
      "Source path was replaced during snapshot: " + path,
    );
    return {
      bytes,
      sourceBefore: state(before),
      sourceAfter: state(after),
      cutoffUtc: new Date().toISOString(),
    };
  } finally {
    closeSync(fd);
  }
}

export function freezeFile(source, destinationRoot, relative, records, maxBytes) {
  assert.ok(
    relative &&
      !relative.startsWith("/") &&
      !relative.includes("\\") &&
      !relative.split("/").includes(".."),
  );
  const prior = records.find((row) => row.path === relative);
  const actual = boundedStableRead(source, maxBytes);
  if (prior) {
    assert.equal(prior.source, source, "Snapshot destination collision.");
    assert.deepEqual(
      actual.sourceBefore,
      prior.sourceAfter,
      "Live source metadata changed after its first cutoff.",
    );
    assert.equal(actual.bytes.length, prior.bytes, "Live source changed after its first cutoff.");
    assert.equal(digest(actual.bytes), prior.sha256, "Live source changed after its first cutoff.");
    const retained = boundedStableRead(join(destinationRoot, relative), maxBytes);
    assert.equal(digest(retained.bytes), prior.sha256, "Frozen snapshot changed.");
    return prior;
  }
  const target = join(destinationRoot, relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, actual.bytes, { flag: "wx" });
  const row = {
    path: relative,
    source,
    bytes: actual.bytes.length,
    sha256: digest(actual.bytes),
    sourceBefore: actual.sourceBefore,
    sourceAfter: actual.sourceAfter,
    cutoffUtc: actual.cutoffUtc,
    immutableCopy: true,
  };
  records.push(row);
  return row;
}

function inventory(root, prefix = "", rows = []) {
  assert.ok(
    prefix.split("/").length < 20 && rows.length < 500,
    "Live output inventory exceeds its bound.",
  );
  for (const name of readdirSync(join(root, prefix)).toSorted()) {
    assert.ok(!name.includes("\\") && !name.startsWith("."));
    const relative = prefix + name;
    const info = lstatSync(join(root, relative));
    assert.equal(info.isSymbolicLink(), false, "Live output links are not allowed.");
    if (info.isDirectory()) inventory(root, relative + "/", rows);
    else {
      assert.ok(info.isFile());
      rows.push({ path: relative, ...state(info) });
      assert.ok(rows.length <= 500, "Live output inventory exceeds its file bound.");
    }
  }
  return rows;
}

export function freezeDirectory(sourceRoot, destinationRoot, records, maxBytes) {
  const before = inventory(sourceRoot);
  assert.ok(
    before.reduce((total, row) => total + row.size, 0) <= maxBytes,
    "Live output exceeds its total bound.",
  );
  for (const row of before)
    freezeFile(
      join(sourceRoot, row.path),
      destinationRoot,
      row.path,
      records,
      Math.min(maxBytes, 80 * 1024 * 1024),
    );
  assert.deepEqual(
    inventory(sourceRoot),
    before,
    "Live output changed during its directory cutoff.",
  );
  return before;
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Bun is the pinned compiler only. The resulting identical ESM bytes run under
// either Node or Bun; every bundled source input must be explicitly authorized.
const root = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const pins = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "pins.json"), "utf8"),
);
const allowed = new Map(
  Object.entries({ ...pins.productionBlobs, [pins.probePath]: pins.probeBlob }).map(
    ([path, sha]) => [resolve(root, path), sha],
  ),
);
const blob = (bytes) =>
  createHash("sha1")
    .update("blob " + bytes.length + "\0")
    .update(bytes)
    .digest("hex");
for (const [path, sha] of allowed) assert.equal(blob(readFileSync(path)), sha);
// Normalize compiler-relative labels only; production runs from an owned private cwd.
process.chdir(root);
const result = await Bun.build({
  root,
  entrypoints: [join(root, pins.probePath)],
  target: "node",
  format: "esm",
  minify: false,
  packages: "bundle",
  metafile: true,
  plugins: [
    {
      name: "exact-shared-source",
      setup(build) {
        build.onResolve({ filter: /^@synara\/shared\//u }, (args) => {
          const path = resolve(
            root,
            "packages/shared/src",
            args.path.slice("@synara/shared/".length) + ".ts",
          );
          assert.ok(allowed.has(path), "Unpinned workspace import");
          return { path };
        });
      },
    },
  ],
});
assert.equal(result.success, true, String(result.logs));
assert.equal(result.outputs.length, 1);
assert.ok(result.metafile);
const inputs = Object.keys(result.metafile.inputs).map((path) => resolve(path));
assert.deepEqual(new Set(inputs), new Set(allowed.keys()), "Unexpected or missing bundled source");
for (const [path, sha] of allowed) assert.equal(blob(readFileSync(path)), sha);
const bytes = Buffer.from(await result.outputs[0].arrayBuffer());
writeFileSync(join(output, "probe.mjs"), bytes, { flag: "wx" });
writeFileSync(
  join(output, "build-metadata.json"),
  JSON.stringify(
    {
      compiler: Bun.version,
      target: "node",
      format: "esm",
      bundleBytes: bytes.length,
      bundleSha256: createHash("sha256").update(bytes).digest("hex"),
      inputs: inputs.map((path) => ({
        path: relative(root, path).replaceAll("\\", "/"),
        gitBlob: allowed.get(path),
      })),
      metafile: result.metafile,
    },
    null,
    2,
  ) + "\n",
);

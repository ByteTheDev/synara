// Temporary integration assembly. The normalized candidate omits this file.
import { readFile, writeFile } from "node:fs/promises";
await import("./connect-extension-edit-providers.mjs");
async function edit(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Expected one acceptance anchor in ${file}: ${before}`);
  await writeFile(file, source.replace(before, after));
}
await edit("apps/web/e2e/editorExtensions.e2e.ts",
  '    await expect(installed.getByRole("button", { name: "Disable", exact: true })).toBeVisible();',
  '    await expect(installed.getByRole("button", { name: "Disable", exact: true })).toBeVisible();\n    await expect(approval).not.toBeVisible();');
const registry = "apps/server/src/extensions/openVsx.ts";
await edit(registry, '  engines: z.object({ vscode: z.string() }),', '  engines: z.object({ vscode: z.string() }),\n  preRelease: z.boolean().optional(),');
await edit(registry, '!semver.prerelease(latest.version) &&', '!latest.preRelease && !semver.prerelease(latest.version) &&');
await edit(registry, 'if (semver.satisfies(CODE_OSS_VERSION, candidate.engines.vscode)) return candidate;', 'if (!candidate.preRelease && semver.satisfies(CODE_OSS_VERSION, candidate.engines.vscode)) return candidate;');
console.log("Added native edit-provider integration, explicit dialog close synchronization and registry prerelease metadata handling.");

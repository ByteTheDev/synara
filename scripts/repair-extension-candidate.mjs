// Temporary bounded candidate repair; excluded from the published application tree.
import { readFile, writeFile } from 'node:fs/promises';
async function replace(file, before, after) {
  const text = await readFile(file, 'utf8');
  if (text.split(before).length !== 2) throw new Error(`Expected one repair anchor in ${file}: ${before}`);
  await writeFile(file, text.replace(before, after));
}
await replace('apps/web/src/components/settings/EditorExtensionsSettingsPanel.tsx',
  'return extensions(input, { signal });', 'return extensions(input, signal ? { signal } : undefined);');
await replace('apps/server/src/extensions/openVsx.ts',
  'if (semver.satisfies(CODE_OSS_VERSION, latest.engines.vscode)) return latest;',
  'if (!semver.prerelease(latest.version) && semver.satisfies(CODE_OSS_VERSION, latest.engines.vscode)) return latest;');
await replace('apps/server/src/extensions/extensionManager.ts',
  'case "remove": {\n          const entry = this.entry(input.id);',
  'case "remove": {\n          const entry = this.entry(input.id);\n          if (!input.version || entry.version !== input.version) throw new Error("The installed extension version changed. Review removal again.");');
console.log('Repaired optional cancellation, stable registry selection and stale removal confirmation.');

// Temporary assembly, omitted from the normalized application candidate.
import { readFile, writeFile } from "node:fs/promises";
await import("./complete-extension-contributions.mjs");
async function edit(file, before, after) {
  const source = await readFile(file, "utf8");
  if (source.split(before).length !== 2) throw new Error(`Expected one contribution repair anchor in ${file}: ${before}`);
  await writeFile(file, source.replace(before, after));
}
await edit("apps/server/src/extensions/manifest.ts", '  for (const views of Object.values(contributes.views ?? {})) {', '  const viewContributions = contributes.views;\n  for (const views of Object.values(viewContributions && typeof viewContributions === "object" ? viewContributions : {})) {');
const interaction = "apps/web/src/components/codeEditor/EditorExtensionInteraction.tsx";
await edit(interaction, '  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);', '  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);\n  const [contributionError, setContributionError] = useState<string | null>(null);');
await edit(interaction, '<EditorExtensionContributions snapshot={state.contributions} controller={bridge.contributions} onError={(error) => { console.warn("Extension contribution failed", error); }} />', '{contributionError ? <p role="alert" className="px-3 py-1 text-ui-sm text-destructive">{contributionError}</p> : null}\n      <EditorExtensionContributions snapshot={state.contributions} controller={bridge.contributions} onError={(error) => setContributionError(error instanceof Error ? error.message : "Extension contribution failed.")} />');
console.log("Prepared native contribution controls and actual linter acceptance.");

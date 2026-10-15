// Temporary candidate assembly. Validation omits this file from publication.
import { readFile, writeFile } from 'node:fs/promises';
await import('./assemble-extension-runtime.mjs');
await import('./wire-extension-editor.mjs');
async function edit(file,before,after){
  const source=await readFile(file,'utf8');
  if(source.split(before).length!==2)throw new Error(`Expected one integration anchor in ${file}: ${before}`);
  await writeFile(file,source.replace(before,after));
}
await edit('apps/server/src/extensions/openVsx.ts',
  'new Set(["open-vsx.org", "openvsxorg.blob.core.windows.net"])',
  'new Set(["open-vsx.org", "openvsxorg.blob.core.windows.net", "openvsx.eclipsecontent.org"])');
await edit('apps/server/src/extensions/extensionRuntime.ts',
  '    const slot = this.own(owner, input);',
  '    // A manager-driven permission change can already have stopped this host.\n    // Existing slots still go through the connection ownership check below.\n    if (input.operation === "stop" && input.hostId && !this.slots.has(input.hostId)) {\n      return { hostId: input.hostId, status: "stopped", sequence: 0, events: [] };\n    }\n    const slot = this.own(owner, input);');
console.log('Integrated the verified production CDN and idempotent cleanup after permission revocation.');

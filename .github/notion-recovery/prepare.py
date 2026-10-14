"""Temporary, fail-fast source recovery edits. Removed from the final product tree."""
from pathlib import Path
import json
import subprocess

root = Path.cwd()
def replace(name, old, new):
    p = root / name
    text = p.read_text()
    if text.count(old) != 1:
        raise RuntimeError(f'{name}: expected one exact recovery anchor, got {text.count(old)}')
    p.write_text(text.replace(old, new, 1))

replace('packages/contracts/src/index.ts', 'export * from "./mcpConnectors";', 'export * from "./mcpConnectors";\nexport * from "./notion";')
replace('packages/shared/package.json', '  "exports": {', '  "exports": {\n    "./notion": {\n      "types": "./src/notion.ts",\n      "import": "./src/notion.ts"\n    },')
replace('apps/server/src/notion/runtime.ts', '  private mutation: Promise<unknown> = Promise.resolve();', '  private mutation: Promise<unknown> = Promise.resolve();\n  private persistence: Promise<void> = Promise.resolve();')
replace('apps/server/src/notion/runtime.ts', 'try { if (Buffer.byteLength(serialized) > SECRET_LIMIT) throw new Error("full"); await this.options.save(serialized); }', 'try {\n      if (Buffer.byteLength(serialized) > SECRET_LIMIT) throw new Error("full");\n      const operation = this.persistence.then(() => { this.ready(); return this.options.save(serialized); });\n      this.persistence = operation.catch(() => { this.storageFailed = true; });\n      await operation;\n    }')
replace('apps/server/src/notion/runtime.ts', 'if (entry.change.state === "synced") return null;', 'if (entry.change.state === "synced") return null;')
# Inspect exact integration boundaries, not entire large modules.
terms = {
  'apps/server/src/wsRpc.ts': ['McpConnectors', 'connectorRpc', 'requireOwner', 'WsRpcs', 'todoService'],
  'apps/server/src/serverLayers.ts': ['TodoServiceLive', 'McpConnectorsLive', 'ServerSecretStoreLive'],
  'apps/web/src/wsTransport.ts': ['RpcClient.make', 'WsRpcs', 'serverGetMcpConnectorSetup'],
  'apps/web/src/wsNativeApi.ts': ['listMcpConnectors', 'export function'],
  'packages/contracts/src/rpc.ts': ['WsServerListMcpConnectorsRpc', 'RpcGroup.make', 'export const WsRpcError'],
  'apps/web/src/routes/_chat.settings.tsx': ['McpConnectorsSettingsPanel', 'integrations', 'case "integrations"'],
}
for name, matches in terms.items():
    lines = (root / name).read_text().splitlines()
    emitted = set()
    print(f'\n=== INTEGRATION BOUNDARY {name} ===')
    for n, line in enumerate(lines):
        if not any(term in line for term in matches):
            continue
        for pos in range(max(0, n - 4), min(len(lines), n + 9)):
            if pos not in emitted:
                print(f'{pos+1}: {lines[pos]}')
                emitted.add(pos)
changed = subprocess.check_output(['git', 'diff', '--name-only', '42fe8a7a66291ce8959bffd20249778752b4601a'], text=True).splitlines()
source = [name for name in changed if name.startswith(('apps/server/', 'apps/web/', 'packages/contracts/', 'packages/shared/')) and name.endswith(('.ts', '.tsx', '.json'))]
(root / '.notion-source-paths.json').write_text(json.dumps(source))
subprocess.run(['bun', 'run', 'fmt', *source], check=True)

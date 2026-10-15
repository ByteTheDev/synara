"""Export verified working-tree edits as Git objects, without commits or ref updates."""
from pathlib import Path
import base64
import json
import os
import subprocess
import urllib.request
api = f'https://api.github.com/repos/{os.environ["GITHUB_REPOSITORY"]}'
def call(path, body=None):
    request = urllib.request.Request(api + path, data=None if body is None else json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)
allowed_prefixes = ('apps/server/src/notion/', 'apps/web/src/components/notion/', 'packages/contracts/', 'packages/shared/')
allowed_paths = {'apps/server/src/wsRpc.ts', 'apps/server/src/serverLayers.ts', 'apps/server/src/todo/Layers/TodoService.ts', 'apps/server/src/agentGateway/todoTools.ts', 'apps/web/src/wsTransport.ts', 'apps/web/src/wsNativeApi.ts', 'apps/web/src/routes/_chat.settings.tsx', 'apps/web/src/components/settings/NotionSettingsPanel.tsx', 'apps/web/src/components/tasks/TaskCard.tsx'}
changed = subprocess.check_output(['git', 'diff', '--name-only'], text=True).splitlines()
entries = []
for name in changed:
    if not name.startswith(allowed_prefixes) and name not in allowed_paths:
        raise RuntimeError('Unexpected recovery edit: ' + name)
    path = Path(name)
    if not path.is_file() or path.stat().st_size > 500000:
        raise RuntimeError('Unexpected recovery file: ' + name)
    blob = call('/git/blobs', {'encoding': 'base64', 'content': base64.b64encode(path.read_bytes()).decode()})
    entries.append({'path': name, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
for name in ['.github/workflows/notion-workspace-bootstrap.yml', '.github/workflows/notion-recovery.yml', '.github/notion-recovery/prepare.py', '.github/notion-recovery/export-tree.py']:
    entries.append({'path': name, 'mode': '100644', 'type': 'blob', 'sha': None})
parent = call('/git/commits/' + os.environ['GITHUB_SHA'])
tree = call('/git/trees', {'base_tree': parent['tree']['sha'], 'tree': entries})
print(json.dumps({'reviewed_parent': os.environ['GITHUB_SHA'], 'prepared_tree': tree['sha'], 'changed_paths': changed}))

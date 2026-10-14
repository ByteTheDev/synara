"""Export reviewed recovery edits as Git objects, never update a branch or create a commit."""
from pathlib import Path
import base64
import json
import os
import subprocess
import urllib.request

repo = os.environ['GITHUB_REPOSITORY']
base = os.environ['GITHUB_SHA']
api = f'https://api.github.com/repos/{repo}'
token = os.environ['GH_TOKEN']
def call(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(api + path, data=data, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)

allowed = ('apps/server/src/notion/', 'packages/contracts/', 'packages/shared/')
changed = subprocess.check_output(['git', 'diff', '--name-only'], text=True).splitlines()
entries = []
for name in changed:
    if not name.startswith(allowed):
        raise RuntimeError('Unexpected recovery edit: ' + name)
    path = Path(name)
    if not path.is_file() or path.stat().st_size > 500000:
        raise RuntimeError('Unexpected recovery file: ' + name)
    blob = call('/git/blobs', {'encoding': 'base64', 'content': base64.b64encode(path.read_bytes()).decode()})
    entries.append({'path': name, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
# Bootstrap tooling is not a product dependency.
for name in ['.github/workflows/notion-workspace-bootstrap.yml', '.github/workflows/notion-recovery.yml', '.github/notion-recovery/prepare.py', '.github/notion-recovery/export-tree.py']:
    entries.append({'path': name, 'mode': '100644', 'type': 'blob', 'sha': None})
parent = call('/git/commits/' + base)
tree = call('/git/trees', {'base_tree': parent['tree']['sha'], 'tree': entries})
print(json.dumps({'reviewed_parent': base, 'prepared_tree': tree['sha'], 'changed_paths': changed}))
Path('/tmp/notion-prepared-tree.json').write_text(json.dumps({'parent': base, 'tree': tree['sha'], 'paths': changed}, indent=2))

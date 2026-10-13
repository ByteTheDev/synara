from pathlib import Path
import hashlib
import json
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
inputs = Path(__file__).resolve().parent
manifest_path = inputs / 'validated-manifest.json'
manifest = json.loads(manifest_path.read_text())
fixes = [
    {
        'path': 'apps/server/src/agentGateway/computerTools.test.ts',
        'old': 'filterToolsByCapability(tools, new Set())',
        'new': 'filterToolsByCapability(tools, new Set<string>())',
        'oldSha': 'b54bbfa47fd6e05b4a492cbab50215632d6a82bb',
        'sha': 'b532837789ab051088d31bf265ae067e0df81605',
        'sha256': 'a7c592687422d23c867fd138890652ea5df6f3aa1a1f25a85f81f4f87e63bb73',
    },
    {
        'path': 'apps/server/src/agentGateway/computerAppPlaybooks.test.ts',
        'old': '[...COMPUTER_HELP_TOPICS].sort()',
        'new': '[...COMPUTER_HELP_TOPICS].toSorted()',
        'oldSha': '35a52c683c46fd49c1d8419a2fccb48f75c16e3e',
        'sha': 'c2df5cb534a1d24df026b0a4ffbb629f36b17968',
        'sha256': 'c682dad710f60c07867cdf426bd9b0faf48fb03be4adeb73805fd81440fe701e',
    },
]
def blob(content):
    return hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest()
for fix in fixes:
    file = root / fix['path']
    content = file.read_bytes()
    assert blob(content) == fix['oldSha'], fix['path']
    text = content.decode()
    assert text.count(fix['old']) == 1
    content = text.replace(fix['old'], fix['new']).encode()
    assert blob(content) == fix['sha'], fix['path']
    assert hashlib.sha256(content).hexdigest() == fix['sha256'], fix['path']
    file.write_bytes(content)
    entry = next(f for f in manifest['files'] if f['path'] == fix['path'])
    entry.update(sha=fix['sha'], sha256=fix['sha256'])
subprocess.run(['git', 'add', '--', *(f['path'] for f in fixes)], cwd=root, check=True)
subprocess.run(['git', 'diff', '--cached', '--check'], cwd=root, check=True)
manifest['testFixtureCorrections'] = fixes
manifest_path.write_text(json.dumps(manifest, indent=2))
print('Verified two test-only corrections. Runtime, guidance, documentation and core prompt unchanged.')

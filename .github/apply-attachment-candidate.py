from pathlib import Path
import base64
import gzip
import hashlib
import json
import subprocess
import sys

workspace = Path(sys.argv[1]).resolve()
inputs = Path(__file__).resolve().parent
manifest = json.loads((inputs / 'attachment-candidate-manifest.json').read_text())
head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=workspace, text=True).strip()
assert head == manifest['base'], f'Unexpected base: {head}'
assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=workspace).strip(), 'Dirty baseline'
encoded = ''.join((inputs / f'attachment-candidate-{i}.b64').read_text().strip() for i in range(4))
# Correct the recorded transport-only copy error; all bytes remain checksum-bound.
encoded = encoded.replace('pQ9gad5/ad5/lP8GZA', 'pQ9gad5/lP8GZA')
patch = gzip.decompress(base64.b64decode(encoded, validate=True))
assert hashlib.sha256(patch).hexdigest() == manifest['patchSha256'], 'Patch transport mismatch'
patch_path = inputs / 'validated-attachment.patch'
patch_path.write_bytes(patch)
subprocess.run(['git', 'apply', '--check', str(patch_path)], cwd=workspace, check=True)
subprocess.run(['git', 'apply', str(patch_path)], cwd=workspace, check=True)
expected = sorted(item['path'] for item in manifest['files'])
changed = subprocess.check_output(['git', 'diff', '--name-only'], cwd=workspace, text=True).splitlines()
untracked = subprocess.check_output(['git', 'ls-files', '--others', '--exclude-standard'], cwd=workspace, text=True).splitlines()
assert sorted(set(changed + untracked)) == expected, 'Unexpected candidate paths'
for item in manifest['files']:
    path = workspace / item['path']
    assert path.resolve().is_relative_to(workspace) and not path.is_symlink()
    content = path.read_bytes()
    assert hashlib.sha256(content).hexdigest() == item['sha256'], f"SHA256 mismatch: {item['path']}"
    sha = hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest()
    assert sha == item['sha'], f"Git blob mismatch: {item['path']}"
subprocess.run(['git', 'add', '-N', '--', *untracked], cwd=workspace, check=True)
subprocess.run(['git', 'diff', '--check'], cwd=workspace, check=True)
print(f'Verified exact {len(expected)}-file candidate on {head}; no refs updated.')

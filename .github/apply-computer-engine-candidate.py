from pathlib import Path
import base64
import hashlib
import json
import lzma
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
transport = Path(__file__).resolve().parent
base = 'a83037154ec3f431004cadf92fec1a3cf9092a30'
assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip() == base
assert not subprocess.check_output(['git', 'status', '--porcelain'], cwd=root)
files = []
for index in range(3):
    payload = json.loads((transport / f'computer-engine-candidate-{index}.json').read_text())
    assert payload['base'] == base
    encoded = base64.b64decode(payload['xzPatch'], validate=True)
    decoder = lzma.LZMADecompressor(memlimit=128 * 1024 * 1024)
    patch = decoder.decompress(encoded, max_length=200_000)
    assert decoder.eof and not decoder.unused_data
    assert hashlib.sha256(patch).hexdigest() == payload['patchSha256']
    for entry in payload['files']:
        path = Path(entry['path'])
        assert not path.is_absolute() and '..' not in path.parts
        assert str(path).startswith(('apps/server/src/', 'apps/desktop/patches/cua-driver/', 'apps/desktop/src/', 'docs/computer-use-cua/', 'packages/shared/src/cuaDriverRelease.json'))
    subprocess.run(['git', 'apply', '--check', '-'], cwd=root, input=patch, check=True)
    subprocess.run(['git', 'apply', '--index', '-'], cwd=root, input=patch, check=True)
    files.extend(payload['files'])
assert len(files) == 19 and len({entry['path'] for entry in files}) == 19
changed = subprocess.check_output(['git', 'diff', '--cached', '--name-only'], cwd=root, text=True).splitlines()
assert sorted(changed) == sorted(entry['path'] for entry in files)
for entry in files:
    path = root / entry['path']
    assert path.resolve().is_relative_to(root) and not path.is_symlink()
    content = path.read_bytes()
    assert hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest() == entry['sha'], entry['path']
subprocess.run(['git', 'diff', '--cached', '--check'], cwd=root, check=True)
(transport / 'validated-manifest.json').write_text(json.dumps({'base': base, 'files': files}, indent=2))
print('Validated exact bytes for', len(files), 'candidate files on', base)

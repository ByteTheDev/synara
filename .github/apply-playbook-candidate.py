from pathlib import Path
import base64
import hashlib
import json
import subprocess
import sys
import zlib

root = Path(sys.argv[1]).resolve()
transport = Path(__file__).resolve().parent
base = '1200e08d7740a7b2a4ffb9f778a09285e0d03cfc'
files = [
    ('apps/server/src/agentGateway/computerAppPlaybooks.test.ts', '35a52c683c46fd49c1d8419a2fccb48f75c16e3e', '9b8af46ecaace522473aaa7445877cd9c563598efbd311b004b358dc353e8ef3'),
    ('apps/server/src/agentGateway/computerAppPlaybooks.ts', '8c40b0e39cdcf2fcb847d7f1960f7b9cf27f4fcb', '784173559cfe629b92033c801e481e3508a0cce9eb79053e92a01c2bf6ee165b'),
    ('apps/server/src/agentGateway/computerGuidance.ts', 'eb58521654b793bd9012896124638f8bce62018f', '6f43553efce14f1051bd87cfcfd9cc3943dd2538da2bd680f6fd0132e819fdad'),
    ('apps/server/src/agentGateway/computerTools.test.ts', 'b54bbfa47fd6e05b4a492cbab50215632d6a82bb', '83d0ec731d05580c1cadb975108924d5df1598d4f12c9ed9f074bd15f15a63b8'),
    ('apps/server/src/agentGateway/computerTools.ts', '2335d8e3077aa7c301e1edb474cb795b5b848550', 'e00de1a5cb3194c22b1dda3dd276d97e8eb4b8830bfb8bc2b00defd60112b035'),
    ('docs/computer-use-cua/README.md', 'ab99a9fad076c5551566ab8a2a798e5f37e1c0bb', 'f5a5163766b021dfea6cfe5a4d9e3297d56f130c8798ae7bd1115c162ea7b9b5'),
    ('docs/computer-use-cua/app-playbooks.md', '11d89d16168826ae8588fe68b14ed8362a187bbc', 'fb3656dcd0bcaa252cf8b68897914c31f41e1bd507a8858269180d331b98da4b'),
]
def git(*args, **kwargs):
    return subprocess.run(['git', *args], cwd=root, check=True, capture_output=True, **kwargs)
assert git('rev-parse', 'HEAD').stdout.decode().strip() == base
encoded = ''.join((transport / f'playbook-candidate-{i}.txt').read_text().strip() for i in range(1, 4))
# Correct a transport-only transcription; the original patch/file hashes remain mandatory.
encoded = encoded.replace('3ZNg8IsoPcp', '3ZNgIsoPcp', 1)
patch = zlib.decompress(base64.b64decode(encoded, validate=True))
assert hashlib.sha256(patch).hexdigest() == '060f561c2a3038a940a79ea156472ca5cab31ff40038e092f040cca078019e0e'
git('apply', '--check', '--index', '-', input=patch)
git('apply', '--index', '-', input=patch)
assert sorted(git('diff', '--cached', '--name-only').stdout.decode().splitlines()) == sorted(f[0] for f in files)
git('diff', '--cached', '--check')
for path, sha, sha256 in files:
    content = (root / path).read_bytes()
    assert hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest() == sha, path
    assert hashlib.sha256(content).hexdigest() == sha256, path
manifest = {'base': base, 'files': [{'path': p, 'sha': s, 'sha256': d} for p,s,d in files]}
(transport / 'validated-manifest.json').write_text(json.dumps(manifest, indent=2))
print('Verified exact parent, seven-file allowlist, original patch digest and all final blobs. No refs changed.')

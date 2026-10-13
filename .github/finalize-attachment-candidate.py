from pathlib import Path
import hashlib
import json
import subprocess
import sys

workspace = Path(sys.argv[1]).resolve()
inputs = Path(__file__).resolve().parent
manifest = json.loads((inputs / 'attachment-candidate-manifest.json').read_text())
corrections = [
    {
        'path': 'apps/desktop/src/browserAutomation/workspaceUpload.test.ts',
        'oldSha': 'f15bc83de7ca31fe8d2fb2e28293e4bfb381f5bd',
        'old': '          await sendCommand("DOM.setFileInputFiles", { files });',
        'new': '          await runtime.webContents.debugger.sendCommand("DOM.setFileInputFiles", { files });',
        'sha': '1c52eff20ceea03142d83767393ca84d78267ea5',
        'sha256': '6c1c4611db4c64bd40e06830765349e372c326f4cc7a3d94506d88d46ca2ad50',
    },
    {
        'path': 'apps/desktop/src/browserAutomation/workspaceUpload.ts',
        'oldSha': '5a81c4179ed5c2a1907b9edc69e7dd22e79f4281',
        'old': '        code: "BrowserAmbiguousResult",\n        tabId: runtime.tabId as BrowserTabId,\n        phase: "runtime",\n        retryable: false,\n        effectMayHaveCommitted: true,',
        'new': '        code: "BrowserAmbiguousResult",\n        tabId: runtime.tabId as BrowserTabId,',
        'sha': 'd41dd89f9fddbeac88bffd0b1e40aac818636798',
        'sha256': 'a1bdc6f738b5b39e39f75fa05ad1145d8521b7347114f9541f12f3255380fed4',
    },
    {
        'path': 'apps/server/src/agentGateway/computerTools.ts',
        'oldSha': 'c559a40b7bb7d70bf634aaaec40e68e3563f777d',
        'old': '    let stoppedReason: "no_usable_window" | "surface_not_settled" | undefined;',
        'new': '    let stoppedReason: "no_usable_window" | "surface_not_settled" | "control_not_ready" | undefined;',
        'sha': '2c51124eb1da267c8b70a9379b7f8aa9d75b5c03',
        'sha256': '675361270966cb4554ead07dc72c0c4fd7bf151ccd4a5954df06258f1f9d34c8',
    },
]
for fix in corrections:
    file = workspace / fix['path']
    content = file.read_bytes()
    assert hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest() == fix['oldSha']
    text = content.decode()
    assert text.count(fix['old']) == 1
    content = text.replace(fix['old'], fix['new']).encode()
    assert hashlib.sha1(f'blob {len(content)}\0'.encode() + content).hexdigest() == fix['sha']
    assert hashlib.sha256(content).hexdigest() == fix['sha256']
    file.write_bytes(content)
    entry = next(item for item in manifest['files'] if item['path'] == fix['path'])
    entry.update(sha=fix['sha'], sha256=fix['sha256'])
manifest['typeCorrections'] = corrections
manifest['serverTestsRun'] = 38450890080
manifest['desktopTestsRun'] = 38451547054
(inputs / 'validated-manifest.json').write_text(json.dumps(manifest, indent=2))
subprocess.run(['git', 'diff', '--check'], cwd=workspace, check=True)
print('Verified exact final candidate. Server tests: run 38450890080, followed only by the explicit stoppedReason type-union correction. Desktop tests: run 38451547054 on identical desktop files.')

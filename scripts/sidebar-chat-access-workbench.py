import base64
import gzip
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request

ROOT = Path('output/sidebar-access')
PAYLOAD = Path('.workbench/sidebar-access.json')
TEST = Path('apps/web/src/components/ChatView.browser.tsx')
CONFIG = Path('apps/web/vitest.browser.config.ts')
BASE = 'fa2404553fd07fceb7e6acd90a882f1bb084da57'


def replace(path, old, new):
    file = Path(path)
    source = file.read_text()
    assert source.count(old) == 1, (str(path), source.count(old))
    file.write_text(source.replace(old, new))


def run(name, command, timeout=240):
    ROOT.mkdir(parents=True, exist_ok=True)
    with (ROOT / f'{name}.log').open('w') as log:
        try:
            code = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            code = 124
    print(f'{name}: exit {code}', flush=True)
    return code


def prepare():
    payload = json.loads(PAYLOAD.read_text())
    encoded = payload['patch'].replace('gDvRXcmR5zm0q', 'gDvRXcmRzm0q').replace('3MtuNs7bS7tj', '3MtuNs7rS7tj')
    patch = Path('/tmp/sidebar.patch')
    patch.write_bytes(gzip.decompress(base64.b64decode(encoded)))
    subprocess.run(['git', 'apply', '--check', str(patch)], check=True)
    subprocess.run(['git', 'apply', str(patch)], check=True)
    replace(TEST, '  type ProjectId,', '  ProjectId,')
    replace(TEST,
        '      // Start a brand-new home chat (draft thread)\n      const newChatButton',
        '      // Start a brand-new home chat (draft thread) from its dedicated list.\n      await page.getByRole("radio", { name: /^Chats/ }).click();\n      const newChatButton')
    replace('apps/web/src/components/Sidebar.tsx',
        '// Projects is always available; Groups and the standalone Chats footer can be hidden',
        '// Projects is always available; Groups and the separate Chats list can be hidden')
    replace('apps/web/src/routes/_chat.settings.tsx',
        'Show the standalone Chats list in the sidebar footer (chats not tied to a project).',
        'Show the Chats tab in the sidebar for chats not tied to a project.')
    replace('apps/web/src/appSettings.ts',
        '// `showChatsSection` controls the standalone "Chats" list in the sidebar footer',
        '// `showChatsSection` controls the standalone "Chats" list and its pinned selector')
    replace('docs/core-concepts.md',
        'Turning off **Show chats section** hides the chooser and returns to Projects.',
        'Turning off **Chats** under **Sidebar sections** hides the chooser and returns to Projects.')
    payload['paths'].extend(['apps/web/src/appSettings.ts', 'apps/web/src/routes/_chat.settings.tsx'])
    PAYLOAD.write_text(json.dumps(payload))
    ROOT.mkdir(parents=True, exist_ok=True)


def checks():
    paths = json.loads(PAYLOAD.read_text())['paths']
    subprocess.run(['bun', 'run', 'fmt', *paths, str(PAYLOAD), '.github/workflows/sidebar-chat-access-workbench.yml'], check=True)
    results = {}
    for name, command in {
        'format': ['bun', 'run', 'fmt:check'],
        'lint': ['bun', 'run', 'lint'],
        'typecheck': ['bun', 'run', 'typecheck'],
    }.items():
        results[name] = run(name, command, timeout=240)
    (ROOT / 'checks.json').write_text(json.dumps(results, indent=2))


def browser():
    pattern = 'thread-list navigation reachable|restores the chat list|falls back to Projects|preserves a new-chat draft when switching|advances from the focused radio|keeps sidebar shortcut hints clear|carries the rail inside'
    result = run('browser', ['bun', 'run', '--cwd', 'apps/web', 'test:browser', 'src/components/ChatView.browser.tsx', 'src/components/settings/RadioGroupKeyboardNav.browser.tsx', '-t', pattern], timeout=360)
    (ROOT / 'browser-result.json').write_text(json.dumps({'exit': result}))


def capture():
    payload = json.loads(PAYLOAD.read_text())
    candidate = {path: Path(path).read_bytes() for path in payload['paths']}
    original_config = CONFIG.read_bytes()
    marker = '  it("keeps persistent turn failure visible after reopening and admits one manual continuation", async () => {'
    capture_test = gzip.decompress(base64.b64decode(payload['capture'])).decode()
    capture_test = capture_test.replace(
        '      if (chats) {\n        chats.click();',
        '      if (chats) {\n        await new Promise((resolve) => setTimeout(resolve, 2000));\n        const content = document.querySelector<HTMLElement>(\'[data-slot="sidebar-content"]\')!;\n        const viewport = content.closest<HTMLElement>(\'[data-slot="scroll-area-viewport"]\')!;\n        viewport.scrollTop = viewport.scrollHeight;\n        await waitForLayout();\n        await new Promise((resolve) => setTimeout(resolve, 1500));\n        chats.click();')
    capture_test = capture_test.replace(
        '        await page.screenshot({ path: "../../../../output/sidebar-access/chats.png" });',
        '        await page.screenshot({ path: "../../../../output/sidebar-access/chats.png" });\n        await new Promise((resolve) => setTimeout(resolve, 2500));\n        await page.getByRole("radio", { name: "Projects", exact: true }).click();\n        await new Promise((resolve) => setTimeout(resolve, 1500));\n        await userEvent.keyboard("{ArrowRight}");\n        await new Promise((resolve) => setTimeout(resolve, 2500));')
    results = {}
    try:
        for variant in ('before', 'after'):
            for path, content in candidate.items():
                Path(path).write_bytes(content)
            CONFIG.write_bytes(original_config)
            if variant == 'before':
                for path in candidate:
                    if path == str(TEST) or path.endswith('SidebarThreadSectionPicker.tsx'):
                        continue
                    original = subprocess.run(['git', 'show', f'{BASE}:{path}'], capture_output=True, check=True).stdout
                    Path(path).write_bytes(original)
            else:
                directory = str((ROOT / 'video').resolve())
                replace(CONFIG, 'provider: playwright(),', f'provider: playwright({{ contextOptions: {{ recordVideo: {{ dir: {json.dumps(directory)}, size: {{ width: 1280, height: 700 }} }} }} }}),')
            source = TEST.read_text()
            assert source.count(marker) == 1
            TEST.write_text(source.replace(marker, capture_test + marker))
            results[variant] = run(f'capture-{variant}', ['bun', 'run', '--cwd', 'apps/web', 'test:browser', str(TEST).removeprefix('apps/web/'), '-t', 'captures sidebar chat access evidence'], timeout=240)
            for name in ('projects', 'chats'):
                image = ROOT / f'{name}.png'
                if image.exists():
                    image.rename(ROOT / f'{variant}-{name}.png')
    finally:
        for path, content in candidate.items():
            Path(path).write_bytes(content)
        CONFIG.write_bytes(original_config)
        (ROOT / 'captures.json').write_text(json.dumps(results, indent=2))
    videos = list((ROOT / 'video').glob('*.webm'))
    if results.get('after') == 0 and videos:
        video = max(videos, key=lambda p: p.stat().st_size)
        # The recorded journey ends with ten seconds of intentional interaction.
        # Keep a short real-browser clip, not a reconstruction from still images.
        run('video-trim', ['ffmpeg', '-y', '-sseof', '-13', '-i', str(video), '-t', '12', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '25', '-movflags', '+faststart', str(ROOT / 'sidebar-switching.mp4')], timeout=60)


def export():
    ROOT.mkdir(parents=True, exist_ok=True)
    paths = json.loads(PAYLOAD.read_text())['paths']
    subprocess.run(['git', 'add', '-N', '--', *paths], check=True)
    diff = subprocess.run(['git', 'diff', '--', *paths], capture_output=True, check=True).stdout
    (ROOT / 'candidate.patch').write_bytes(diff)
    manifest = []
    def upload(path, data):
        request = urllib.request.Request(
            f'https://api.github.com/repos/{os.environ["REPOSITORY"]}/git/blobs',
            data=json.dumps({'content': base64.b64encode(data).decode(), 'encoding': 'base64'}).encode(),
            headers={'Authorization': f'Bearer {os.environ["GH_TOKEN"]}', 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(request, timeout=30) as response:
            blob = json.load(response)
        manifest.append({'path': path, 'mode': '100644', 'type': 'blob', 'sha': blob['sha']})
    for path in paths:
        data = Path(path).read_bytes()
        upload(path, data)
        copy = ROOT / 'candidate' / path
        copy.parent.mkdir(parents=True, exist_ok=True)
        copy.write_bytes(data)
    for media in [*ROOT.glob('*.png'), *ROOT.glob('*.mp4')]:
        upload(f'docs/pr-screenshots/sidebar-chat-access/{media.name}', media.read_bytes())
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


def gate():
    checks = json.loads((ROOT / 'checks.json').read_text())
    browser_result = json.loads((ROOT / 'browser-result.json').read_text())
    captures = json.loads((ROOT / 'captures.json').read_text())
    success = all(code == 0 for code in checks.values()) and browser_result['exit'] == 0 and captures == {'before': 0, 'after': 0}
    print(json.dumps({'checks': checks, 'browser': browser_result, 'captures': captures}, indent=2))
    raise SystemExit(0 if success else 1)


if __name__ == '__main__':
    {'prepare': prepare, 'checks': checks, 'browser': browser, 'capture': capture, 'export': export, 'gate': gate}[sys.argv[1]]()

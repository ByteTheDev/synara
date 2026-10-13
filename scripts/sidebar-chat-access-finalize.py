import json
from pathlib import Path
import runpy
import subprocess
import sys

core = runpy.run_path('scripts/sidebar-chat-access-workbench.py')
ROOT = core['ROOT']
TEST = core['TEST']
replace = core['replace']
run = core['run']


def prepare():
    for name in ('browser', 'format', 'lint', 'typecheck'):
        path = ROOT / f'{name}.log'
        if path.exists():
            path.rename(ROOT / f'previous-{name}.log')
    core['prepare']()
    replace(TEST,
        '      await waitForServerConfigToApply();\n      const projects = page.getByRole("radio", { name: "Projects", exact: true });',
        '      await waitForServerConfigToApply();\n      // Restored historical completions start read; explicitly model an unread one.\n      useStore.getState().markThreadUnread(snapshot.threads[29]!.id);\n      const projects = page.getByRole("radio", { name: "Projects", exact: true });')
    replace(TEST,
        '      const completed = snapshot.threads[29]!;\n      useStore.getState().markThreadVisited(completed.id, NOW_ISO);',
        '      const completed = snapshot.threads[29]!;\n      useStore.getState().markThreadUnread(completed.id);\n      await expect.element(chats).toHaveAttribute("aria-label", "Chats — needs attention");\n      useStore.getState().markThreadVisited(completed.id, NOW_ISO);')


def checks():
    paths = json.loads(core['PAYLOAD'].read_text())['paths']
    subprocess.run(['bun', 'run', 'fmt', *paths, str(core['PAYLOAD']), '.github/workflows/sidebar-chat-access-workbench.yml'], check=True)
    results = {
        'format': run('format', ['bun', 'run', 'fmt:check']),
        'lint': run('lint', ['bun', 'run', 'lint']),
        'web-typecheck': run('typecheck', ['bun', 'run', '--cwd', 'apps/web', 'typecheck']),
    }
    (ROOT / 'checks.json').write_text(json.dumps(results, indent=2))


def browser():
    # This evidence call is deliberately ephemeral, not committed into the regression test.
    original = TEST.read_bytes()
    marker = '      // The unread completion is beyond the five-row preview; selecting Chats must not read it.\n      await expect.element(chats).toHaveAttribute("aria-label", "Chats — needs attention");'
    replace(TEST, marker, marker + '\n      await page.screenshot({ path: "../../../../output/sidebar-access/after-attention.png" });')
    try:
        result = run('browser', ['bun', 'run', '--cwd', 'apps/web', 'test:browser', 'src/components/ChatView.browser.tsx', '-t', 'thread-list navigation reachable|restores the chat list', '--testTimeout=20000'], timeout=180)
    finally:
        TEST.write_bytes(original)
    (ROOT / 'browser-result.json').write_text(json.dumps({'exit': result}))
    videos = list((ROOT / 'video').glob('*.webm'))
    if videos:
        video = max(videos, key=lambda path: path.stat().st_size)
        run('video-trim', ['ffmpeg', '-y', '-sseof', '-13', '-i', str(video), '-t', '12', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '25', '-movflags', '+faststart', str(ROOT / 'sidebar-switching.mp4')], timeout=60)


if __name__ == '__main__':
    {'prepare': prepare, 'checks': checks, 'browser': browser, 'export': core['export'], 'gate': core['gate']}[sys.argv[1]]()

from pathlib import Path
import base64
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import urllib.request

BASE = '9df497b9f5481c77435df9fd0d7f5291b264efd5'
ROOT = Path('/tmp/sidebar-navigation-rows')
ROOT.mkdir(exist_ok=True)
SHOTS = Path('output/sidebar-navigation-rows')
PATHS = [
    'apps/web/src/components/Sidebar.tsx',
    'apps/web/src/components/SidebarThreadSectionPicker.tsx',
    'apps/web/src/components/SidebarThreadSectionPicker.browser.tsx',
    'apps/web/src/components/SegmentedPicker.tsx',
    'apps/web/src/index.css',
    'apps/web/src/routes/_chat.settings.tsx',
    'docs/core-concepts.md',
]
TEST = Path('apps/web/src/components/ChatView.browser.tsx')
CONFIG = Path('apps/web/vitest.browser.config.ts')


def replace(path, old, new):
    file = Path(path)
    text = file.read_text()
    assert text.count(old) == 1, (path, text.count(old))
    file.write_text(text.replace(old, new))


def run(name, command, timeout=240):
    logpath = ROOT / f'{name}.log'
    with logpath.open('w') as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
            code = 124
    print(name, code, flush=True)
    if code:
        print('\n'.join(logpath.read_text(errors='replace').splitlines()[-45:]), flush=True)
    return code


def prepare():
    for name in ('SidebarThreadSectionPicker', 'SidebarThreadSectionPicker.browser'):
        Path(f'apps/web/src/components/{name}.tsx').write_bytes(Path(f'.workbench/{name}.txt').read_bytes())
    path = 'apps/web/src/components/SegmentedPicker.tsx'
    Path(path).write_bytes(subprocess.check_output(['git', 'show', f'5255564d812f67aca85d489d3632e10ae8338c23:{path}']))
    path = PATHS[0]
    replace(path, '{!showThreadSectionPicker ? betaBadge : null}', '{betaBadge}')
    replace(path, '''                {showThreadSectionPicker ? (
                  <div className="ml-auto">{betaBadge}</div>
                ) : (
                  sidebarHeaderActions
                )}''', '                {sidebarHeaderActions}')
    replace(path, '''                >
                  {sidebarHeaderActions}
                </SidebarThreadSectionPicker>''', '                />')
    replace(path, 'className="flex shrink-0 items-center gap-1 pt-1.5 pb-1 pr-2.5 pl-1.5"', 'className="flex shrink-0 flex-wrap items-center gap-1 pt-1.5 pb-1 pr-2.5 pl-1.5"')
    path = Path('apps/web/src/index.css')
    css = path.read_text()
    start = css.index('/* Compact sidebar toolbar variant.')
    end = css.index('\n}', css.index('  .sidebar-segmented-picker-inset [aria-checked="true"]', start)) + 2
    css = css[:start] + '''/* List navigation shares sidebar row styling, not a segmented track or moving thumb. */
@media (prefers-contrast: more) {
  .sidebar-list-destination[aria-checked="true"] {
    outline: 1px solid currentColor;
    outline-offset: -1px;
  }
}

@media (forced-colors: active) {
  .sidebar-list-destination[aria-checked="true"] {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }

  .sidebar-list-destination:focus-visible {
    outline: 2px solid ButtonText;
    outline-offset: -4px;
  }
}
''' + css[end:]
    path.write_text(css)
    replace('apps/web/src/routes/_chat.settings.tsx', 'Show the Chats tab in the sidebar for chats not tied to a project.', 'Show Chats in the sidebar for conversations not tied to a project.')
    replace('docs/core-concepts.md', 'The Home panel keeps **Projects** and **Chats** above the scrolling list, alongside Search and\n  Activity.', 'The Home panel keeps **Projects** and **Chats** as pinned navigation rows above the scrolling\n  list, with Search and Activity beside the title. The rows use the same icons and selection\n  treatment as the sidebar, without a sliding segmented control.')
    replace('docs/core-concepts.md', 'hides the chooser and returns to Projects.', 'hides the navigation rows and returns to Projects.')


def checks():
    subprocess.run(['bun', 'run', 'fmt', *PATHS, '.github/workflows/sidebar-navigation-rows.yml'], check=True)
    commands = {
        'format': ['bun', 'run', 'fmt:check'],
        'lint': ['bun', 'run', 'lint'],
        'typecheck': ['bun', 'run', 'typecheck'],
        'unit': ['bun', 'run', 'test:web:focused', 'src/components/Sidebar.uiState.test.ts', 'src/uiFontSize.test.ts', 'src/hasSelectorVariants.test.ts'],
    }
    results = {name: run(name, command) for name, command in commands.items()}
    (ROOT / 'checks.json').write_text(json.dumps(results, indent=2))


def browser():
    pattern = 'stable sidebar destinations|sidebar destination focus|thread-list navigation reachable|restores the chat list|falls back to Projects|preserves a new-chat draft when switching|carries the rail inside'
    code = run('browser', ['bun', 'run', '--cwd', 'apps/web', 'test:browser', 'src/components/SidebarThreadSectionPicker.browser.tsx', 'src/components/ChatView.browser.tsx', '-t', pattern], timeout=300)
    (ROOT / 'browser.json').write_text(json.dumps({'exit': code}))


CAPTURE = '''
  it.each(["light", "dark"] as const)("captures plain sidebar destinations (%s)", async (theme) => {
    localStorage.setItem("synara:sidebar-ui:v1", JSON.stringify({ chatSectionExpanded: true, projectThreadListExtraPagesByCwd: { "/repo/project": 5 } }));
    localStorage.setItem("synara:app-settings:v1", JSON.stringify({ sidebarThreadSortOrder: "created_at", sidebarThreadAttentionFirst: false }));
    localStorage.setItem("synara:theme", theme);
    const snapshot = createSidebarListSnapshot();
    const mounted = await mountChatView({ viewport: { ...DEFAULT_VIEWPORT, width: 1280, height: 700 }, snapshot });
    try {
      await waitForServerConfigToApply();
      window.dispatchEvent(new StorageEvent("storage", { key: "synara:theme", newValue: theme }));
      await expect.poll(() => document.documentElement.classList.contains("dark")).toBe(theme === "dark");
      useStore.getState().markThreadUnread(snapshot.threads[29]!.id);
      const projects = page.getByRole("radio", { name: "Projects", exact: true });
      const chats = page.getByRole("radio", { name: "Chats — needs attention", exact: true });
      await expect.element(chats).toBeVisible();
      await waitForLayout();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await page.screenshot({ path: `../../../../output/sidebar-navigation-rows/after-${theme}-projects.png` });
      const content = document.querySelector<HTMLElement>('[data-slot="sidebar-content"]')!;
      const viewport = content.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      const before = chats.element().getBoundingClientRect().top;
      viewport.scrollTop = viewport.scrollHeight;
      await waitForLayout();
      expect(chats.element().getBoundingClientRect().top).toBeCloseTo(before, 0);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await chats.click();
      await expect.element(page.getByRole("button", { name: "Open Chat 01", exact: true })).toBeVisible();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await page.screenshot({ path: `../../../../output/sidebar-navigation-rows/after-${theme}-chats.png` });
      await projects.click();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await userEvent.keyboard("{ArrowDown}");
      await expect.element(chats).toHaveAttribute("aria-checked", "true");
      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await userEvent.keyboard("{ArrowUp}");
      await expect.element(projects).toHaveAttribute("aria-checked", "true");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } finally {
      await mounted.cleanup();
    }
  });
'''


def capture():
    SHOTS.mkdir(parents=True, exist_ok=True)
    for theme in ('light', 'dark'):
        for section in ('projects', 'chats'):
            source = Path(f'docs/pr-screenshots/sidebar-chat-access/apple-redesign/after-{theme}-{section}.png')
            shutil.copyfile(source, ROOT / f'before-{theme}-{section}.png')
    original_test = TEST.read_text()
    original_config = CONFIG.read_text()
    marker = '  it("keeps thread-list navigation reachable and shortcuts scoped to visible chats", async () => {'
    assert original_test.count(marker) == 1
    try:
        TEST.write_text(original_test.replace(marker, CAPTURE + marker))
        video_dir = json.dumps(str((ROOT / 'video').resolve()))
        config = original_config.replace('provider: playwright(),', 'provider: playwright({ contextOptions: { recordVideo: { dir: ' + video_dir + ', size: { width: 1280, height: 700 } } } }),')
        assert config != original_config
        CONFIG.write_text(config)
        code = run('capture', ['bun', 'run', '--cwd', 'apps/web', 'test:browser', 'src/components/ChatView.browser.tsx', '-t', 'captures plain sidebar destinations'], timeout=240)
    finally:
        TEST.write_text(original_test)
        CONFIG.write_text(original_config)
    for image in SHOTS.glob('*.png'):
        shutil.copyfile(image, ROOT / image.name)
    videos = list((ROOT / 'video').glob('*.webm'))
    video_code = 1
    if code == 0 and videos:
        video = max(videos, key=lambda path: path.stat().st_size)
        video_code = run('video', ['ffmpeg', '-y', '-sseof', '-11.5', '-i', str(video), '-t', '11', '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '24', '-movflags', '+faststart', str(ROOT / 'sidebar-navigation.mp4')], timeout=60)
    (ROOT / 'captures.json').write_text(json.dumps({'browser': code, 'video': video_code}, indent=2))


def export():
    subprocess.run(['git', 'diff', '--check'], check=True)
    (ROOT / 'candidate.patch').write_bytes(subprocess.check_output(['git', 'diff', BASE, '--', *PATHS]))
    objects = [(path, Path(path).read_bytes()) for path in PATHS]
    for path, data in objects:
        copy = ROOT / 'candidate' / path
        copy.parent.mkdir(parents=True, exist_ok=True)
        copy.write_bytes(data)
    objects.extend((f'docs/pr-screenshots/sidebar-chat-access/navigation-rows/{file.name}', file.read_bytes()) for file in [*ROOT.glob('after-*.png'), *ROOT.glob('*.mp4')])
    manifest = []
    for path, data in objects:
        request = urllib.request.Request(f'https://api.github.com/repos/{os.environ["REPOSITORY"]}/git/blobs', data=json.dumps({'content': base64.b64encode(data).decode(), 'encoding': 'base64'}).encode(), headers={'Authorization': f'Bearer {os.environ["GH_TOKEN"]}', 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json'}, method='POST')
        with urllib.request.urlopen(request, timeout=30) as response:
            blob = json.load(response)
        assert blob['sha'] == hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest()
        manifest.append({'path': path, 'type': 'blob', 'mode': '100644', 'sha': blob['sha']})
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


def gate():
    results = {name: json.loads((ROOT / f'{name}.json').read_text()) for name in ('checks', 'browser', 'captures')}
    print(json.dumps(results, indent=2))
    assert all(value == 0 for group in results.values() for value in group.values()), results
    assert len(list(ROOT.glob('after-*.png'))) == 4
    assert (ROOT / 'sidebar-navigation.mp4').stat().st_size > 0


if __name__ == '__main__':
    {'prepare': prepare, 'checks': checks, 'browser': browser, 'capture': capture, 'export': export, 'gate': gate}[sys.argv[1]]()

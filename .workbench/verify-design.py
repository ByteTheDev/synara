from pathlib import Path
import base64, hashlib, json, os, subprocess, sys, urllib.request

ROOT = Path('/tmp/sidebar-apple-design')
ROOT.mkdir(exist_ok=True)
BASE = '5255564d812f67aca85d489d3632e10ae8338c23'
PATHS = ['apps/web/src/components/SegmentedPicker.tsx', 'apps/web/src/components/SidebarThreadSectionPicker.tsx', 'apps/web/src/components/Sidebar.tsx', 'apps/web/src/components/SidebarThreadSectionPicker.browser.tsx', 'apps/web/src/index.css']
TEST = Path('apps/web/src/components/ChatView.browser.tsx')
CONFIG = Path('apps/web/vitest.browser.config.ts')


def run(name, command, timeout=240):
    with (ROOT / f'{name}.log').open('w') as log:
        try:
            code = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, timeout=timeout).returncode
        except subprocess.TimeoutExpired:
            code = 124
    print(name, code, flush=True)
    return code


def check():
    subprocess.run(['bun', 'run', 'fmt', *PATHS, '.github/workflows/sidebar-apple-design.yml'], check=True)
    results = {}
    for name, command in {
        'format': ['bun', 'run', 'fmt:check'],
        'lint': ['bun', 'run', 'lint'],
        'typecheck': ['bun', 'run', 'typecheck'],
        'unit': ['bun', 'run', 'test:web:focused', 'src/components/Sidebar.uiState.test.ts', 'src/uiFontSize.test.ts', 'src/hasSelectorVariants.test.ts'],
    }.items():
        results[name] = run(name, command)
    (ROOT / 'checks.json').write_text(json.dumps(results, indent=2))


def browser():
    pattern = 'contains selection and keeps labels stable|keeps selection visible without animation|thread-list navigation reachable|restores the chat list|falls back to Projects|preserves a new-chat draft when switching|carries the rail inside'
    result = run('browser', ['bun', 'run', '--cwd', 'apps/web', 'test:browser', 'src/components/SidebarThreadSectionPicker.browser.tsx', 'src/components/ChatView.browser.tsx', '-t', pattern, '--testTimeout=20000'], timeout=300)
    (ROOT / 'browser.json').write_text(json.dumps({'exit': result}))


CAPTURE = '''
  it.each(["light", "dark"] as const)("captures Apple-inspired sidebar (%s)", async (theme) => {
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
      await new Promise((resolve) => setTimeout(resolve, 800));
      await page.screenshot({ path: `/tmp/sidebar-apple-design/__VARIANT__-${theme}-projects.png` });
      const content = document.querySelector<HTMLElement>('[data-slot="sidebar-content"]')!;
      const viewport = content.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
      const before = chats.element().getBoundingClientRect().top;
      viewport.scrollTop = viewport.scrollHeight;
      await waitForLayout();
      expect(chats.element().getBoundingClientRect().top).toBeCloseTo(before, 0);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await chats.click();
      await expect.element(page.getByRole("button", { name: "Open Chat 01", exact: true })).toBeVisible();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await page.screenshot({ path: `/tmp/sidebar-apple-design/__VARIANT__-${theme}-chats.png` });
      await projects.click();
      await new Promise((resolve) => setTimeout(resolve, 650));
      await userEvent.keyboard("{ArrowRight}");
      await expect.element(chats).toHaveAttribute("aria-checked", "true");
      expect(mounted.router.state.location.pathname).toBe(`/${THREAD_ID}`);
      await new Promise((resolve) => setTimeout(resolve, 900));
    } finally {
      await mounted.cleanup();
    }
  });
'''


def capture():
    candidate = {path: Path(path).read_bytes() for path in PATHS}
    original_test = TEST.read_text()
    original_config = CONFIG.read_text()
    marker = '  it("keeps thread-list navigation reachable and shortcuts scoped to visible chats", async () => {'
    assert original_test.count(marker) == 1
    results = {}
    try:
        for variant in ('before', 'after'):
            for path, data in candidate.items():
                Path(path).write_bytes(data)
            CONFIG.write_text(original_config)
            if variant == 'before':
                for path in PATHS:
                    if path.endswith('.browser.tsx'):
                        continue
                    original = subprocess.check_output(['git', 'show', f'{BASE}:{path}'])
                    Path(path).write_bytes(original)
            else:
                config = original_config.replace('provider: playwright(),', 'provider: playwright({ contextOptions: { recordVideo: { dir: "/tmp/sidebar-apple-design/video", size: { width: 1280, height: 700 } } } }),')
                assert config != original_config
                CONFIG.write_text(config)
            TEST.write_text(original_test.replace(marker, CAPTURE.replace('__VARIANT__', variant) + marker))
            results[variant] = run(f'capture-{variant}', ['bun', 'run', '--cwd', 'apps/web', 'test:browser', 'src/components/ChatView.browser.tsx', '-t', 'captures Apple-inspired sidebar', '--testTimeout=20000'], timeout=240)
    finally:
        for path, data in candidate.items():
            Path(path).write_bytes(data)
        TEST.write_text(original_test)
        CONFIG.write_text(original_config)
        (ROOT / 'captures.json').write_text(json.dumps(results, indent=2))
    videos = list((ROOT / 'video').glob('*.webm'))
    if results.get('after') == 0 and videos:
        video = max(videos, key=lambda path: path.stat().st_size)
        run('video', ['ffmpeg', '-y', '-sseof', '-12', '-i', str(video), '-an', '-c:v', 'libx264', '-preset', 'fast', '-crf', '24', '-movflags', '+faststart', str(ROOT / 'sidebar-design.mp4')], timeout=60)


def export():
    subprocess.run(['git', 'diff', '--check'], check=True)
    (ROOT / 'candidate.patch').write_bytes(subprocess.check_output(['git', 'diff', BASE, '--', *PATHS]))
    manifest = []
    objects = [(path, Path(path).read_bytes()) for path in PATHS]
    for path, data in objects:
        copy = ROOT / 'candidate' / path
        copy.parent.mkdir(parents=True, exist_ok=True)
        copy.write_bytes(data)
    objects.extend((f'docs/pr-screenshots/sidebar-chat-access/apple-redesign/{file.name}', file.read_bytes()) for file in [*ROOT.glob('*.png'), *ROOT.glob('*.mp4')])
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


{'check': check, 'browser': browser, 'capture': capture, 'export': export, 'gate': gate}[sys.argv[1]]()

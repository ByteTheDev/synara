// Frame-by-frame view of a warm switch back to a fully measured chat.
import { chromium } from "/Users/emanueledipietro/Developer/synara/.claude/worktrees/chat-performance-loading-694d73/apps/web/node_modules/playwright/index.mjs";
const port = process.argv[2] ?? "3898";
const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--window-size=1440,960"],
});
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "commit" });
await page.waitForSelector('[aria-label="Open Fix light-mode hero overlay"]', { timeout: 60000 });
for (let q = Date.now(); Date.now() - q < 2500; ) {
  for (const n of ["Not now", "Skip tour"]) {
    const b = page.getByRole("button", { name: n });
    if (await b.count()) {
      await b.first().click();
      q = Date.now();
    }
  }
  await page.waitForTimeout(250);
}
const visibleList = () =>
  page.evaluate(() => {
    const l = [...document.querySelectorAll('[data-chat-scroll-container="true"]')].find(
      (el) =>
        el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().width > 0,
    );
    const r = l.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
await page.locator('[aria-label="Open Fix light-mode hero overlay"]').first().click();
await page.waitForTimeout(1500);
const box = await visibleList();
await page.mouse.move(box.x, box.y);
for (let i = 0; i < 100; i++) {
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(16);
}
await page.waitForTimeout(800);
await page.locator('[aria-label="Open Same Chat Handoff Issue"]').first().click();
await page.waitForTimeout(1500);
const watch = page.evaluate(
  () =>
    new Promise((resolve) => {
      const log = [];
      let t0 = null;
      addEventListener("pointerdown", (e) => (t0 ??= e.timeStamp), { capture: true, once: true });
      const tick = (now) => {
        if (t0 !== null) {
          const lists = [...document.querySelectorAll('[data-chat-scroll-container="true"]')];
          const l = lists.find(
            (el) =>
              el.checkVisibility({ visibilityProperty: true }) &&
              el.getBoundingClientRect().width > 0,
          );
          const rows = l ? [...l.querySelectorAll("[data-timeline-row-kind]")] : [];
          const visibleRows = rows.filter((r) =>
            r.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
          ).length;
          // Which ancestor hides the first row?
          let hider = null;
          if (rows[0] && visibleRows === 0) {
            for (let el = rows[0]; el && el !== document.body; el = el.parentElement) {
              const cs = getComputedStyle(el);
              if (cs.opacity === "0" || cs.visibility === "hidden") {
                hider = `${el.tagName}.${String(el.className).slice(0, 50)} op=${cs.opacity} vis=${cs.visibility}`;
                break;
              }
            }
          }
          log.push(
            `${(now - t0).toFixed(0)}ms lists=${lists.length} rows=${rows.length} visible=${visibleRows} st=${l ? Math.round(l.scrollTop) : "-"} sh=${l ? l.scrollHeight : "-"} ${hider ?? ""}`,
          );
          if (now - t0 > 400) return resolve(log);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
);
await page.locator('[aria-label="Open Fix light-mode hero overlay"]').first().click();
const log = await watch;
let last = "";
for (const line of log) {
  const sig = line.replace(/^\d+ms /, "");
  if (sig !== last) {
    console.log(line);
    last = sig;
  }
}
await browser.close();

// A user session in a headed (GPU) Chromium: open the app, click chats in the sidebar,
// switch back, and wheel-scroll into older messages. Records a DevTools Performance
// trace (loadable in Chrome's Performance panel) plus in-page frame and interaction data.
// usage: node user-session.mjs <label> <port> <out-dir>
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "/Users/emanueledipietro/Developer/synara/.claude/worktrees/chat-performance-loading-694d73/apps/web/node_modules/playwright/index.mjs";

const [label, port, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const ORIGIN = `http://127.0.0.1:${port}`;
const DB = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "perf",
  "state.seeded.sqlite",
);
const ids = (threadId) =>
  JSON.parse(
    execFileSync(
      "sqlite3",
      [
        "-json",
        DB,
        `select message_id id from projection_thread_messages where thread_id='${threadId}'`,
      ],
      { encoding: "utf8" },
    ) || "[]",
  ).map((row) => row.id);

const CHATS = {
  mega: { title: "PERF mega tools (6x)", id: "perf0000-mega-tool-0000-000000000001" },
  long: { title: "PERF long chat (20x)", id: "perf0000-long-chat-0000-000000000002" },
  hero: { title: "Fix light-mode hero overlay", id: "730ef11a-0b9f-4b21-a84f-5e2e92919823" },
  handoff: { title: "Same Chat Handoff Issue", id: "00b17d3f-b78d-4f31-b019-1be67ce0bb74" },
  small: {
    title: "Setting per disattivare horizontal tabs",
    id: "8173d226-c625-4211-b91c-e311ffb7c4cc",
  },
};
for (const chat of Object.values(CHATS)) chat.messageIds = ids(chat.id);

const browser = await chromium.launch({
  channel: "chrome",
  headless: false,
  args: ["--window-size=1440,960"],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  const bench = (window.__user = { loaf: [], events: [], longTasks: [] });
  // Kept-alive chat panes stay in the DOM hidden; only the visible transcript counts.
  window.__visibleList = () =>
    [...document.querySelectorAll('[data-chat-scroll-container="true"]')].find(
      (el) =>
        el.checkVisibility({ visibilityProperty: true }) && el.getBoundingClientRect().width > 0,
    ) ?? null;
  const observe = (type, sink, extra = {}) => {
    try {
      new PerformanceObserver((list) => sink.push(...list.getEntries())).observe({
        type,
        buffered: true,
        ...extra,
      });
    } catch {}
  };
  observe("long-animation-frame", bench.loaf);
  observe("event", bench.events, { durationThreshold: 16 });
  observe("longtask", bench.longTasks);
});
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

// ---- startup: open the app at Home like a user launching it
const navStart = Date.now();
await page.goto(`${ORIGIN}/`, { waitUntil: "commit" });
await page.waitForSelector('[aria-label="Open PERF mega tools (6x)"]', { timeout: 60_000 });
const startupMs = Date.now() - navStart;
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown";
});
// First-run dialogs, dismissed the way a user would.
for (let quietSince = Date.now(); Date.now() - quietSince < 2500; ) {
  for (const name of ["Not now", "Skip tour"]) {
    const button = page.getByRole("button", { name });
    if (await button.count()) {
      await button.first().click();
      quietSince = Date.now();
    }
  }
  await page.waitForTimeout(250);
}
const idleFrameMs = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const t = [];
      const f = (now) => (
        t.push(now), t.length < 61 ? requestAnimationFrame(f) : resolve((t[60] - t[0]) / 60)
      );
      requestAnimationFrame(f);
    }),
);

const events = [];
cdp.on("Tracing.dataCollected", (batch) => events.push(...batch.value));
await cdp.send("Tracing.start", {
  categories: [
    "-*",
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "disabled-by-default-devtools.timeline.stack",
    "v8.execute",
    "blink.user_timing",
    "latencyInfo",
    "loading",
  ].join(","),
  transferMode: "ReportEvents",
});

const results = { label, gpu, idleFrameMs: +idleFrameMs.toFixed(2), startupMs, steps: [] };

// Click a sidebar chat with the real mouse; time to first row of that chat and to a
// settled bottom, plus the click's own event-timing duration (INP-style).
async function openChat(name, kind) {
  const chat = CHATS[name];
  await page.evaluate((step) => performance.mark(`step:${step}:start`), `${kind}:${name}`);
  const watch = page.evaluate(
    ({ ids, step }) =>
      new Promise((resolve) => {
        const wanted = new Set(ids);
        let t0 = null;
        addEventListener("pointerdown", (event) => (t0 ??= event.timeStamp), {
          capture: true,
          once: true,
        });
        let first = null;
        let bottom = null;
        let lastMove = 0;
        let last = null;
        const tick = (now) => {
          if (t0 !== null) {
            const list = window.__visibleList();
            if (first === null && list) {
              for (const row of list.querySelectorAll("[data-message-id]")) {
                if (
                  wanted.has(row.dataset.messageId) &&
                  row.checkVisibility({ opacityProperty: true, visibilityProperty: true })
                ) {
                  first = now;
                  break;
                }
              }
            }
            const geometry = list ? [list.scrollHeight, list.scrollTop] : [0, 0];
            if (
              !last ||
              Math.abs(geometry[0] - last[0]) > 8 ||
              Math.abs(geometry[1] - last[1]) > 8
            ) {
              last = geometry;
              lastMove = now;
            }
            if (
              bottom === null &&
              first !== null &&
              list &&
              list.scrollHeight - list.scrollTop - list.clientHeight < 8
            )
              bottom = now;
            if ((first !== null && now - lastMove > 800) || now - t0 > 20_000) {
              performance.mark(`step:${step}:end`);
              return resolve({
                firstRowMs: first && first - t0,
                bottomMs: bottom && bottom - t0,
                settledMs: lastMove - t0,
                t0,
              });
            }
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    { ids: chat.messageIds, step: `${kind}:${name}` },
  );
  const row = page.locator(`[aria-label="Open ${chat.title}"]`).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  const timing = await watch;
  const interaction = await page.evaluate(
    (t0) =>
      window.__user.events
        .filter(
          (entry) =>
            entry.interactionId && entry.startTime >= t0 - 50 && entry.startTime < t0 + 500,
        )
        .reduce((max, entry) => Math.max(max, entry.duration), 0),
    timing.t0,
  );
  const step = { step: `${kind}:${name}`, ...timing, clickInteractionMs: interaction };
  delete step.t0;
  results.steps.push(step);
  await page.waitForTimeout(700);
}

// Wheel up through older messages at a steady human pace, measuring every frame.
async function readOlder(name, wheelEvents) {
  await page.evaluate((step) => performance.mark(`step:${step}:start`), `scroll:${name}`);
  const box = await page.evaluate(() => {
    const r = window.__visibleList().getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  await page.mouse.move(box.x, box.y);
  await page.evaluate(() => {
    const rec = (window.__scrollRec = {
      gaps: [],
      running: true,
      startTop: null,
      jumps: 0,
      jumpPx: 0,
    });
    const list = (rec.list = window.__visibleList());
    rec.startTop = list.scrollTop;
    rec.startHeight = list.scrollHeight;
    let lastTop = list.scrollTop;
    list.addEventListener(
      "scroll",
      () => {
        if (list.scrollTop > lastTop + 1) {
          rec.jumps += 1;
          rec.jumpPx += list.scrollTop - lastTop;
        }
        lastTop = list.scrollTop;
      },
      { passive: true },
    );
    rec.loafBefore = window.__user.loaf.length;
    let prev = performance.now();
    const tick = (now) => {
      if (!rec.running) return;
      rec.gaps.push(now - prev);
      prev = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  for (let i = 0; i < wheelEvents; i += 1) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(500);
  const scroll = await page.evaluate(() => {
    const rec = window.__scrollRec;
    rec.running = false;
    const list = rec.list;
    const loaf = window.__user.loaf.slice(rec.loafBefore);
    return {
      gaps: rec.gaps.slice(1),
      jumps: rec.jumps,
      jumpPx: Math.round(rec.jumpPx),
      scrolledPx: Math.round(rec.startTop - list.scrollTop + (list.scrollHeight - rec.startHeight)),
      longAnimationFrames: loaf.length,
      loafBlockingMs: Math.round(loaf.reduce((sum, f) => sum + (f.blockingDuration ?? 0), 0)),
      loafStyleLayoutMs: Math.round(
        loaf.reduce(
          (sum, f) =>
            sum +
            Math.max(
              0,
              f.startTime + f.duration - (f.styleAndLayoutStart || f.startTime + f.duration),
            ),
          0,
        ),
      ),
    };
  });
  await page.evaluate((step) => performance.mark(`step:${step}:end`), `scroll:${name}`);
  results.steps.push({ step: `scroll:${name}`, ...scroll });
}

await openChat("mega", "cold");
await readOlder("mega", 150);
await openChat("handoff", "cold");
await openChat("mega", "warm");
await openChat("long", "cold");
await readOlder("long", 80);
await openChat("hero", "cold");
await readOlder("hero", 100);
await openChat("handoff", "warm");
await openChat("small", "cold");
await openChat("long", "warm");
await openChat("hero", "warm");

const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
await cdp.send("Tracing.end");
await done;
writeFileSync(path.join(outDir, `${label}.trace.json`), JSON.stringify({ traceEvents: events }));
writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(results, null, 2));
console.log(JSON.stringify({ label, gpu, idleFrameMs: results.idleFrameMs, startupMs }));
await browser.close();

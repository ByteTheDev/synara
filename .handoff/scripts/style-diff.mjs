// Compare computed styles of the rewritten :has() surfaces between baseline and candidate.
import { chromium } from "/Users/emanueledipietro/Developer/synara/.claude/worktrees/chat-performance-loading-694d73/apps/web/node_modules/playwright/index.mjs";

const PROPS = [
  "opacity",
  "pointer-events",
  "padding-right",
  "padding-left",
  "padding-top",
  "padding-bottom",
  "height",
  "min-height",
  "padding-inline-end",
  "padding-inline-start",
];
const browser = await chromium.launch({ headless: true });

async function dismiss(page) {
  for (let quiet = Date.now(); Date.now() - quiet < 2000; ) {
    for (const name of ["Not now", "Skip tour"]) {
      const button = page.getByRole("button", { name });
      if (await button.count()) {
        await button.first().click();
        quiet = Date.now();
      }
    }
    await page.waitForTimeout(200);
  }
}

const snapshot = (page, rootSelector) =>
  page.evaluate(
    ({ rootSelector, PROPS }) =>
      [...document.querySelectorAll(rootSelector)].map((root) =>
        [root, ...root.querySelectorAll("*")].map((el) => {
          const cs = getComputedStyle(el);
          return `${el.tagName}:${PROPS.map((p) => cs.getPropertyValue(p)).join("|")}`;
        }),
      ),
    { rootSelector, PROPS },
  );

async function collect(port) {
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 900 } })
  ).newPage();
  const out = {};
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForSelector(".group\\/project-header", { timeout: 60_000 });
  await dismiss(page);
  out.projectHeaderIdle = await snapshot(page, ".group\\/project-header");
  // Keyboard focus inside each project header (what `group-has-[:focus-visible]` keyed on).
  const headers = await page.locator(".group\\/project-header").count();
  out.projectHeaderFocused = [];
  for (let i = 0; i < headers; i += 1) {
    const focused = await page.evaluate((index) => {
      const header = document.querySelectorAll(".group\\/project-header")[index];
      const target = header?.querySelector("button, [role=button], a, [tabindex]");
      if (!target) return false;
      target.focus({ focusVisible: true });
      return target.matches(":focus-visible");
    }, i);
    const snap = await snapshot(page, ".group\\/project-header");
    out.projectHeaderFocused.push({ focused, header: snap[i] });
    await page.evaluate(() => document.activeElement?.blur());
  }
  // Settings: the terminal font autocomplete (trigger + clear after the input).
  for (const section of ["appearance", "terminal", "general", "editor"]) {
    await page.goto(`http://127.0.0.1:${port}/settings?section=${section}`, { waitUntil: "load" });
    await page.waitForTimeout(1500);
    if (await page.locator('input[aria-label="Terminal font family"]').count()) {
      out.settingsSection = section;
      out.terminalFontInput = await page.evaluate(() => {
        const input = document.querySelector('input[aria-label="Terminal font family"]');
        const chain = [];
        for (let el = input; el && chain.length < 3; el = el.parentElement) {
          const cs = getComputedStyle(el);
          chain.push(
            `${el.tagName} pe=${cs.paddingInlineEnd} ps=${cs.paddingInlineStart} w=${Math.round(el.getBoundingClientRect().width)}`,
          );
        }
        return chain;
      });
      break;
    }
  }
  // Create project dialog: input groups and their addons.
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
  await page.waitForSelector(".group\\/project-header");
  await dismiss(page);
  const add = page.getByRole("button", { name: "Add project" }).first();
  if (await add.count()) {
    await add.click();
    await page.waitForSelector('[data-slot="input-group"]', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    out.inputGroups = await snapshot(page, '[data-slot="input-group"]');
  }
  await page.context().close();
  return out;
}

const base = await collect(process.argv[2] ?? "3899");
const cand = await collect(process.argv[3] ?? "3898");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
console.log(
  "project headers:",
  base.projectHeaderIdle.length,
  "idle identical:",
  same(base.projectHeaderIdle, cand.projectHeaderIdle),
);
console.log(
  "focused headers:",
  base.projectHeaderFocused.map((h) => h.focused).join(","),
  "| identical:",
  same(base.projectHeaderFocused, cand.projectHeaderFocused),
);
const changedByFocus = base.projectHeaderFocused.filter(
  (h, i) => !same(h.header, base.projectHeaderIdle[i]),
).length;
console.log("headers whose styles change on keyboard focus (baseline):", changedByFocus);
console.log("settings section:", base.settingsSection, cand.settingsSection);
console.log("terminal font input base:", base.terminalFontInput);
console.log("terminal font input cand:", cand.terminalFontInput);
console.log(
  "input groups:",
  base.inputGroups?.length,
  "identical:",
  same(base.inputGroups, cand.inputGroups),
);
if (!same(base.inputGroups, cand.inputGroups)) {
  base.inputGroups?.forEach((group, g) =>
    group.forEach((line, i) => {
      if (line !== cand.inputGroups?.[g]?.[i])
        console.log(" diff", g, i, line, "=>", cand.inputGroups?.[g]?.[i]);
    }),
  );
}
if (!same(base.projectHeaderFocused, cand.projectHeaderFocused)) {
  base.projectHeaderFocused.forEach((h, k) =>
    h.header?.forEach((line, i) => {
      const other = cand.projectHeaderFocused[k]?.header?.[i];
      if (line !== other) console.log(" header diff", k, i, line, "=>", other);
    }),
  );
}
await browser.close();

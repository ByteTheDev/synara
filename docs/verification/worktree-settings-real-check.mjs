// Real production settings persistence, all providers disabled, local only.
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
const { chromium } = await import(
  new URL("./apps/web/node_modules/playwright/index.mjs", "file://" + process.cwd() + "/")
);
const root = process.cwd(),
  home = await fs.mkdtemp("/tmp/synara-settings-acceptance-");
await fs.mkdir(home + "/userdata");
await fs.writeFile(
  home + "/userdata/settings.json",
  JSON.stringify({
    onboardingCompletedAt: new Date().toISOString(),
    providers: Object.fromEntries(
      [
        "codex",
        "claudeAgent",
        "cursor",
        "devin",
        "antigravity",
        "grok",
        "droid",
        "pi",
        "omp",
        "opencode",
      ].map((p) => [p, { enabled: false }]),
    ),
  }),
);
const output = await fs.open("/tmp/settings-acceptance-server.log", "w");
const server = spawn(
  process.execPath,
  [
    "apps/server/dist/index.mjs",
    "--home-dir",
    home,
    "--host",
    "127.0.0.1",
    "--port",
    "44520",
    "--no-browser",
  ],
  { cwd: root, stdio: ["ignore", output.fd, output.fd] },
);
const exited = once(server, "exit");
let browser;
try {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch("http://127.0.0.1:44520")).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({
    ...(process.env.SYNARA_CHROMIUM_PATH
      ? { executablePath: process.env.SYNARA_CHROMIUM_PATH }
      : {}),
    headless: true,
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto("http://127.0.0.1:44520");
  await page.getByRole("button", { name: "Not now", exact: true }).waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await page.getByRole("button", { name: "Skip tour", exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "Skip tour", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.goto("http://127.0.0.1:44520/settings?section=worktrees");
  const toggle = page.getByRole("switch", { name: "Remove archived worktrees after merge" });
  await toggle.waitFor();
  assert.equal(await toggle.isChecked(), false);
  await page.mouse.move(1400, 900);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: root + "/docs/verification/worktree-settings-real-default.png" });
  await toggle.click();
  for (let i = 0; i < 50; i++) {
    const s = JSON.parse(await fs.readFile(home + "/userdata/settings.json", "utf8"));
    if ((s.settings ?? s).worktrees?.pruneAfterMerge === true) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(
    JSON.parse(await fs.readFile(home + "/userdata/settings.json", "utf8")).settings.worktrees
      .pruneAfterMerge,
    true,
  );
  await page.reload();
  await toggle.waitFor();
  for (let i = 0; i < 50 && !(await toggle.isChecked()); i++) await page.waitForTimeout(100);
  assert.equal(await toggle.isChecked(), true);
  await page.screenshot({ path: root + "/docs/verification/worktree-settings-real-enabled.png" });
  await toggle.click();
  await page.waitForTimeout(500);
  assert.equal(
    JSON.parse(await fs.readFile(home + "/userdata/settings.json", "utf8")).settings.worktrees
      .pruneAfterMerge,
    false,
  );
  console.log(
    "PASS",
    JSON.stringify({
      home,
      defaultOff: true,
      persistedEnabled: true,
      reloadRetained: true,
      revertedOff: true,
    }),
  );
} finally {
  await browser?.close();
  server.kill("SIGKILL");
  await exited.catch(() => {});
  await output.close();
}

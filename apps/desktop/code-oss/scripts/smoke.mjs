/** Isolated, real-application Linux smoke. No provider tokens or production data. */
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const requireWeb = createRequire(join(root, "apps/web/package.json"));
const requireDesktop = createRequire(join(root, "apps/desktop/package.json"));
const { _electron } = requireWeb("playwright");
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.SYNARA_SMOKE_OUTPUT ?? ".code-oss/smoke");
await mkdir(output, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "synara-native-smoke-"));
const workspace = join(home, "workspace");
await mkdir(workspace);
await writeFile(
  join(workspace, "sample.ts"),
  'export const result: number = "intentional diagnostic";\n',
);
await mkdir(join(workspace, ".vscode"));
await writeFile(
  join(workspace, "debug.cjs"),
  'const value = 21;\ndebugger;\nconsole.log("SYNARA_DEBUG_OK", value * 2);\n',
);
await writeFile(
  join(workspace, ".vscode/launch.json"),
  JSON.stringify({
    version: "0.2.0",
    configurations: [
      {
        name: "Synara native smoke",
        type: "node",
        request: "launch",
        program: "${workspaceFolder}/debug.cjs",
        console: "internalConsole",
      },
    ],
  }),
);
execFileSync("git", ["init", "-b", "main", workspace]);
execFileSync("git", ["-C", workspace, "add", "."]);
execFileSync("git", [
  "-C",
  workspace,
  "-c",
  "user.name=Synara Smoke",
  "-c",
  "user.email=smoke@example.invalid",
  "commit",
  "-m",
  "Isolated smoke workspace",
]);
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  SYNARA_HOME: join(home, "synara"),
  SYNARA_DESKTOP_SMOKE_USER_DATA: join(home, "electron"),
  SYNARA_DESKTOP_FLAVOR: "production",
  ELECTRON_ENABLE_LOGGING: "1",
  SYNARA_CODE_OSS_RUNTIME_DIR: baseline ? join(home, "no-runtime") : resolve(".code-oss/runtime"),
};
for (const key of [
  "VITE_DEV_SERVER_URL",
  "ELECTRON_RUN_AS_NODE",
  "SYNARA_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
])
  delete env[key];
let application;
let log = "";
const checks = [];
const record = (name, detail) => {
  checks.push({ name, detail, passed: true });
  console.log("PASS", name, detail ?? "");
};
async function until(read, predicate, label, milliseconds = 60_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
async function screen(name) {
  execFileSync("scrot", ["-o", join(output, name)], { timeout: 10_000 });
}
try {
  application = await _electron.launch({
    executablePath: requireDesktop("electron"),
    args: [join(root, "apps/desktop/dist-electron/main.js")],
    cwd: workspace,
    env,
    timeout: 90_000,
  });
  application.process().stdout?.on("data", (bytes) => {
    log += bytes;
  });
  application.process().stderr?.on("data", (bytes) => {
    log += bytes;
  });
  const findPage = async (test) => {
    for (const page of application.context().pages()) {
      try {
        if (await page.evaluate(test)) return page;
      } catch {
        /* Pages can navigate during startup. */
      }
    }
    return null;
  };
  const agent = await until(
    () => findPage(() => Boolean(window.desktopBridge)),
    Boolean,
    "existing Synara Agent renderer",
    90_000,
  );
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
  });
  await agent.locator("body").waitFor({ state: "visible" });
  await until(
    () => agent.locator("body").innerText(),
    (text) => text.length > 100,
    "Agent UI hydration",
  );
  await writeFile(
    join(output, baseline ? "before-dom.txt" : "agent-dom.txt"),
    await agent.locator("body").innerText(),
  );
  if (baseline) {
    await screen("before-agent-mode.png");
    record(
      "baseline application starts",
      "Actual main-branch React application, fresh isolated profile",
    );
  } else {
    const state = await until(
      () => agent.evaluate(() => window.desktopBridge.ide.getState()),
      (value) => value.status === "ready",
      "Code-OSS desktop ready",
      90_000,
    );
    if (state.mode !== "agent") throw new Error("Existing users must start in Agent Mode.");
    record("native workbench starts in same app", state.status);
    const windows = await application.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length,
    );
    if (windows !== 1) throw new Error(`Expected one application window, received ${windows}.`);
    const identity = await application.evaluate(({ app }) => ({
      pid: process.pid,
      name: app.getName(),
      profile: app.getPath("userData"),
    }));
    record("single window and process identity", identity);
    await agent.evaluate(() => {
      window.__synaraSmokeIdentity = crypto.randomUUID();
    });
    const marker = await agent.evaluate(() => window.__synaraSmokeIdentity);
    const inputs = agent.locator('[contenteditable="true"]');
    const hasDraft = (await inputs.count()) > 0;
    if (hasDraft) await inputs.first().fill("Unsaved Synara draft — native mode smoke");
    await screen("after-agent-mode.png");
    await agent.evaluate((scope) => window.desktopBridge.ide.setScope(scope), {
      threadId: state.scope.threadId,
      projectId: state.scope.projectId,
      roots: [workspace],
    });
    await agent.evaluate(() => window.desktopBridge.ide.setMode("ide"));
    const workbench = await until(
      () => findPage(() => Boolean(document.querySelector(".monaco-workbench"))),
      Boolean,
      "native Code-OSS workbench DOM",
    );
    await workbench.locator(".monaco-workbench").waitFor();
    const trust = workbench.getByRole("button", { name: /Yes, I trust the authors/ });
    if (await trust.count()) await trust.first().click();
    await screen("after-ide-mode.png");
    const command = async (title) => {
      await workbench.keyboard.press("Control+Shift+P");
      const input = workbench.locator(".quick-input-widget input").first();
      await input.waitFor({ state: "visible" });
      await input.fill(">" + title);
      await workbench.keyboard.press("Enter");
      await input.waitFor({ state: "hidden" });
    };
    await workbench.keyboard.press("Control+p");
    await workbench.locator(".quick-input-widget input").first().fill(join(workspace, "sample.ts"));
    await workbench.keyboard.press("Enter");
    await workbench.locator(".editor-instance .view-lines").first().waitFor();
    await workbench.keyboard.press("Control+End");
    await workbench.keyboard.type("\n// MANUAL_UNSAVED_BUFFER\n");
    await until(
      () => workbench.locator(".view-lines").allTextContents(),
      (lines) => lines.join("\n").includes("MANUAL_UNSAVED_BUFFER"),
      "manual native editor input",
    );
    if ((await readFile(join(workspace, "sample.ts"), "utf8")).includes("MANUAL_UNSAVED_BUFFER"))
      throw new Error("Unexpected implicit file save.");
    await agent.evaluate(() => window.desktopBridge.ide.setMode("agent"));
    if ((await agent.evaluate(() => window.__synaraSmokeIdentity)) !== marker)
      throw new Error("Agent renderer reloaded during mode switch.");
    if (hasDraft && !(await inputs.first().innerText()).includes("Unsaved Synara draft"))
      throw new Error("Agent draft changed during mode switch.");
    await screen("after-return-to-agent.png");
    await agent.evaluate(() => window.desktopBridge.ide.setMode("ide"));
    await until(
      () => workbench.locator(".view-lines").allTextContents(),
      (lines) => lines.join("\n").includes("MANUAL_UNSAVED_BUFFER"),
      "dirty editor retained after switching",
    );
    record("Agent and dirty editor state survives mode switching", {
      retainedRenderer: true,
      draftExercised: hasDraft,
    });
    await writeFile(join(workspace, "sample.ts"), "// EXTERNAL_DISK_CHANGE\n");
    await new Promise((done) => setTimeout(done, 1000));
    if (
      !(await workbench.locator(".view-lines").allTextContents())
        .join("\n")
        .includes("MANUAL_UNSAVED_BUFFER")
    )
      throw new Error("External file change replaced a dirty editor.");
    record("dirty editor survives external disk update");
    await command("Synara: New Terminal in Active Worktree");
    await workbench.keyboard.type("printf SYNARA_TERMINAL_OK > terminal-smoke.txt");
    await workbench.keyboard.press("Enter");
    await until(
      async () => {
        try {
          return await readFile(join(workspace, "terminal-smoke.txt"), "utf8");
        } catch {
          return "";
        }
      },
      (text) => text === "SYNARA_TERMINAL_OK",
      "native terminal process writes in selected worktree",
    );
    record("native terminal process and workspace cwd");
    await command("View: Toggle Problems");
    await screen("after-editor-and-panels.png");
    record("native workbench panels", "Problems command executed");
    await writeFile(join(output, "native-dom.txt"), await workbench.locator("body").innerText());
  }
} catch (error) {
  await screen(baseline ? "before-failure.png" : "after-failure.png").catch(() => {});
  if (application) {
    for (const [index, page] of application.context().pages().entries()) {
      await writeFile(
        join(output, `failure-page-${index}.txt`),
        page.url() + "\n" + (await page.locator("body").innerText().catch(() => "unavailable")),
      ).catch(() => {});
    }
    const contents = await application.evaluate(({ webContents }) =>
      webContents.getAllWebContents().map((item) => ({
        id: item.id,
        type: item.getType(),
        url: item.getURL(),
      })),
    );
    await writeFile(join(output, "webcontents.json"), JSON.stringify(contents, null, 2));
  }
  await writeFile(join(output, "failure.txt"), String(error.stack ?? error));
  throw error;
} finally {
  await writeFile(
    join(output, baseline ? "before-checks.json" : "after-checks.json"),
    JSON.stringify(checks, null, 2),
  );
  await writeFile(join(output, baseline ? "before-electron.log" : "after-electron.log"), log);
  // Only this harness's temporary profile is closed and removed; never production data.
  if (application) await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await rm(home, { recursive: true, force: true });
}

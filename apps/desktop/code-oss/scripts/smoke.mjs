/** Real Linux desktop acceptance in disposable data; never uses provider credentials. */
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";

const root = process.cwd();
const requireWeb = createRequire(join(root, "apps/web/package.json"));
const requireDesktop = createRequire(join(root, "apps/desktop/package.json"));
const { _electron } = requireWeb("playwright");
const baseline = process.argv.includes("--baseline");
const output = resolve(process.env.SYNARA_SMOKE_OUTPUT ?? ".code-oss/smoke");
await mkdir(output, { recursive: true });
const home = await mkdtemp(join(tmpdir(), "synara-native-smoke-"));
const workspace = join(home, "workspace");
const profile = join(home, "config/synara");
const probeOutput = join(home, "native-probe.json");
await mkdir(workspace);
await writeFile(
  join(workspace, "sample.ts"),
  'import { double } from "./helper";\nexport const answer = double(21);\nexport const invalid: number = "intentional diagnostic";\nconst greeting = "Synara";\ngreeting.toUpperCase();\n',
);
await writeFile(
  join(workspace, "helper.ts"),
  "export const double = (value: number): number => value * 2;\n",
);
await writeFile(
  join(workspace, "debug.cjs"),
  'const value = 21;\ndebugger;\nconsole.log("SYNARA_DEBUG_OK", value * 2);\n',
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
  "Isolated acceptance workspace",
]);
if (!baseline) {
  const extension = join(profile, "extensions/synara-test.integration-smoke-0.0.1");
  await mkdir(extension, { recursive: true });
  const commands = [
    ["open", "Open sample file"],
    ["inspect", "Inspect state"],
    ["languages", "Check language services"],
    ["selection", "Send code to Synara"],
    ["debug", "Start debugger"],
    ["stopDebug", "Stop debugger"],
  ].map(([id, title]) => ({ command: `synaraSmoke.${id}`, title: `Synara Smoke: ${title}` }));
  await writeFile(
    join(extension, "package.json"),
    JSON.stringify({
      name: "integration-smoke",
      publisher: "synara-test",
      version: "0.0.1",
      engines: { vscode: "^1.141.0" },
      main: "probe.cjs",
      activationEvents: ["onStartupFinished"],
      extensionKind: ["workspace"],
      capabilities: { untrustedWorkspaces: { supported: true } },
      contributes: { commands },
    }),
  );
  await copyFile(new URL("./fixtures/probe.cjs", import.meta.url), join(extension, "probe.cjs"));
  await writeFile(
    join(extension, "probe.json"),
    JSON.stringify({ workspace, output: probeOutput, node: process.execPath }),
  );
}
const env = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  SYNARA_HOME: join(home, "synara"),
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
let recording;
let log = "";
const checks = [];
async function record(name, detail) {
  checks.push({ name, detail, passed: true });
  await writeFile(
    join(output, baseline ? "before-checks.json" : "after-checks.json"),
    JSON.stringify(checks, null, 2),
  );
  console.log("PASS", name, JSON.stringify(detail ?? null));
}
async function until(read, predicate, label, milliseconds = 45_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
async function probe() {
  try {
    return JSON.parse(await readFile(probeOutput, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}
function screen(name) {
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
  application.context().setDefaultTimeout(20_000);
  async function findPage(test) {
    for (const page of application.context().pages()) {
      try {
        if (await page.evaluate(test)) return page;
      } catch {
        /* Navigation during startup. */
      }
    }
    return null;
  }
  const agent = await until(
    () => findPage(() => Boolean(window.desktopBridge)),
    Boolean,
    "existing Synara renderer",
    90_000,
  );
  await application.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows())
      window.setBounds({ x: 0, y: 0, width: 1440, height: 960 });
  });
  await until(
    () => agent.locator("body").innerText(),
    (text) => text.length > 100,
    "Agent hydration",
  );
  const skipSetup = agent.getByRole("button", { name: "Skip setup", exact: true });
  await skipSetup.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
  if (await skipSetup.isVisible()) await skipSetup.click();
  if (baseline) {
    screen("before-agent-mode.png");
    await record(
      "original Synara application starts",
      "Fresh isolated profile; no IDE integration",
    );
  } else {
    const state = await until(
      () => agent.evaluate(() => window.desktopBridge.ide.getState()),
      (value) => value.status === "ready" && value.scope.threadId,
      "native desktop ready and shared session selected",
      90_000,
    );
    if (state.mode !== "agent") throw new Error("Agent Mode must remain the default");
    const identity = await application.evaluate(({ app, BrowserWindow }) => ({
      pid: process.pid,
      name: app.getName(),
      profile: app.getPath("userData"),
      windows: BrowserWindow.getAllWindows().length,
    }));
    if (identity.windows !== 1 || identity.profile !== profile)
      throw new Error(`Unexpected application ownership: ${JSON.stringify(identity)}`);
    await record("one Synara application and profile", identity);
    await agent.evaluate(() => {
      window.__synaraSmokeIdentity = crypto.randomUUID();
      window.__synaraSmokeContexts = [];
      window.desktopBridge.ide.onContext((context) => window.__synaraSmokeContexts.push(context));
    });
    const marker = await agent.evaluate(() => window.__synaraSmokeIdentity);
    const composer = agent.locator('[contenteditable="true"]').first();
    await composer.fill("Review the TypeScript change; keep this draft unsent.");
    screen("after-agent-mode.png");
    await agent.evaluate((scope) => window.desktopBridge.ide.setScope(scope), {
      ...state.scope,
      roots: [workspace],
    });
    await agent.getByRole("button", { name: "Switch to IDE Mode", exact: true }).first().click();
    const workbench = await until(
      () => findPage(() => Boolean(document.querySelector(".monaco-workbench"))),
      Boolean,
      "actual Code-OSS workbench",
    );
    const trust = workbench.getByRole("button", { name: /Yes, I trust the authors/ });
    await trust
      .first()
      .waitFor({ state: "visible", timeout: 3000 })
      .catch(() => {});
    if (await trust.first().isVisible()) await trust.first().click();
    const initialProbe = await until(
      probe,
      (value) => value.activated,
      "native Node extension host activates local compatible extension",
    );
    await record("native extension host activation", { pid: initialProbe.extensionHostPid });
    async function command(title) {
      await application.evaluate(({ webContents }) =>
        webContents
          .getAllWebContents()
          .find((item) => item.getURL().startsWith("vscode-file:"))
          ?.focus(),
      );
      await workbench.keyboard.press("Control+Shift+P");
      const input = workbench.locator(".quick-input-widget input:visible").first();
      await input.fill(">" + title);
      await workbench.keyboard.press("Enter");
      await input.waitFor({ state: "hidden" });
    }
    async function probeCommand(id, title) {
      await command("Synara Smoke: " + title);
      const result = await until(probe, (value) => value.command === `synaraSmoke.${id}`, title);
      if (result.error) throw new Error(result.error);
      return result;
    }
    await probeCommand("open", "Open sample file");
    await workbench.locator(".monaco-editor .view-lines").first().waitFor();
    const language = await probeCommand("languages", "Check language services");
    if (!language.definitionCount || !language.completionLabels.includes("toUpperCase"))
      throw new Error("TypeScript definition/completion provider failed");
    const diagnostic = await until(
      probe,
      (value) => value.diagnostics?.some((item) => item.severity === 0),
      "native TypeScript diagnostics",
    );
    await record("TypeScript extension, definition, completion and diagnostics", {
      active: language.typescriptActive,
      definitions: language.definitionCount,
      diagnostics: diagnostic.diagnostics,
    });
    await workbench.keyboard.press("Control+Shift+m");
    screen("after-ide-editor.png");
    await probeCommand("selection", "Send code to Synara");
    const contexts = await until(
      () => agent.evaluate(() => window.__synaraSmokeContexts),
      (values) => values.some((value) => value.kind === "selection"),
      "selected code reaches existing Synara composer",
    );
    if (!contexts[0].text.includes("double")) throw new Error("Wrong code was attached to Synara");
    if (!(await composer.innerText()).includes("keep this draft unsent"))
      throw new Error("Context replaced the existing draft");
    screen("after-ide-agent-context.png");
    await record("native selection attaches to existing unsent Synara draft", {
      threadId: contexts[0].threadId,
      kind: contexts[0].kind,
    });
    await probeCommand("debug", "Start debugger");
    const debug = await until(
      probe,
      (value) => value.debugStopped && value.stackFrames?.length,
      "native JavaScript debugger pauses with stack",
    );
    screen("after-ide-debugger.png");
    await record("native debug adapter and call stack", { stack: debug.stackFrames });
    await agent.evaluate(() => window.desktopBridge.ide.setMode("agent"));
    if ((await agent.evaluate(() => window.__synaraSmokeIdentity)) !== marker)
      throw new Error("Agent renderer reloaded");
    await agent.getByRole("button", { name: "Switch to IDE Mode", exact: true }).first().click();
    const resumed = await probeCommand("inspect", "Inspect state");
    if (
      resumed.debugSession !== debug.debugSession ||
      resumed.extensionHostPid !== initialProbe.extensionHostPid
    )
      throw new Error("Mode switching restarted native services");
    await record("debugging and extension-host state survive mode switching");
    await probeCommand("stopDebug", "Stop debugger");
    await probeCommand("open", "Open sample file");
    await workbench.keyboard.press("Control+End");
    await workbench.keyboard.type("\n// MANUAL_UNSAVED_BUFFER\n");
    const dirty = await probeCommand("inspect", "Inspect state");
    if (!dirty.editor?.dirty || !dirty.editor.text.includes("MANUAL_UNSAVED_BUFFER"))
      throw new Error("Native editor did not retain manual changes");
    await agent.evaluate(() => window.desktopBridge.ide.setMode("agent"));
    if (!(await composer.innerText()).includes("keep this draft unsent"))
      throw new Error("Agent draft lost across switch");
    screen("after-return-to-agent.png");
    await agent.getByRole("button", { name: "Switch to IDE Mode", exact: true }).first().click();
    await writeFile(join(workspace, "sample.ts"), "// EXTERNAL_DISK_CHANGE\n");
    await new Promise((done) => setTimeout(done, 1500));
    const protectedBuffer = await probeCommand("inspect", "Inspect state");
    if (
      !protectedBuffer.editor?.dirty ||
      !protectedBuffer.editor.text.includes("MANUAL_UNSAVED_BUFFER")
    )
      throw new Error("External write replaced a dirty editor");
    await record("dirty buffers and Agent drafts survive mode switches and external writes");
    await command("Synara: New Terminal in Active Worktree");
    await workbench.keyboard.type(
      "printf SYNARA_TERMINAL_OK > terminal-smoke.txt; (sleep 2; printf CONTINUED > terminal-after-switch.txt) &",
    );
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
      "native terminal executes in selected workspace",
    );
    await agent.evaluate(() => window.desktopBridge.ide.setMode("agent"));
    await until(
      async () => {
        try {
          return await readFile(join(workspace, "terminal-after-switch.txt"), "utf8");
        } catch {
          return "";
        }
      },
      (text) => text === "CONTINUED",
      "terminal process continues in Agent Mode",
    );
    await agent.getByRole("button", { name: "Switch to IDE Mode", exact: true }).first().click();
    const git = await probeCommand("inspect", "Inspect state");
    if (!git.git?.some((repo) => repo.root === workspace && repo.changes.length > 0))
      throw new Error("Native Git did not observe workspace changes");
    screen("after-ide-terminal.png");
    await record("native terminal, worktree cwd, process continuity and Git", {
      terminals: git.terminals,
      repositories: git.git,
    });
    // Capture an actual short X11 video only after all functional checks pass.
    recording = spawn(
      "ffmpeg",
      [
        "-y",
        "-f",
        "x11grab",
        "-video_size",
        "1440x1000",
        "-framerate",
        "8",
        "-i",
        process.env.DISPLAY,
        "-t",
        "8",
        "-vf",
        "scale=1080:-2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        join(output, "agent-ide-switch.mp4"),
      ],
      { stdio: "ignore" },
    );
    await new Promise((done) => setTimeout(done, 1200));
    await agent.evaluate(() => window.desktopBridge.ide.setMode("agent"));
    await new Promise((done) => setTimeout(done, 2000));
    await agent.getByRole("button", { name: "Switch to IDE Mode", exact: true }).first().click();
    await new Promise((done) => recording.once("exit", done));
    recording = undefined;
    await writeFile(join(output, "native-probe.json"), JSON.stringify(await probe(), null, 2));
    await writeFile(join(output, "native-dom.txt"), await workbench.locator("body").innerText());
  }
} catch (error) {
  screen(baseline ? "before-failure.png" : "after-failure.png");
  await writeFile(join(output, "failure.txt"), String(error.stack ?? error));
  if (application) {
    for (const [index, page] of application.context().pages().entries()) {
      await writeFile(
        join(output, `failure-page-${index}.txt`),
        page.url() +
          "\n" +
          (await page
            .locator("body")
            .innerText()
            .catch(() => "unavailable")),
      ).catch(() => {});
    }
    await writeFile(join(output, "probe-at-failure.json"), JSON.stringify(await probe(), null, 2));
  }
  throw error;
} finally {
  if (recording) recording.kill("SIGTERM");
  await writeFile(join(output, baseline ? "before-electron.log" : "after-electron.log"), log);
  if (application) await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

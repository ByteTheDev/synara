import { test, expect, type Page, type TestInfo } from "playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { seedEditorProject } from "./editorAcceptanceFixture";

// Real app, real registry, actual VSIX, production sandbox and native writer.
// There is no response interception, mock extension or replacement native API.
let cwd: string;
const before = "const answer={value:42}";
const after = "const answer = { value: 42 };\n";
test.beforeAll(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), "synara-extensions-ui-"));
  await writeFile(path.join(cwd, "example.js"), before);
  execFileSync("git", ["init", "-b", "main", cwd]);
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Extension acceptance",
    "-c",
    "user.email=extension-test@example.invalid",
    "commit",
    "-m",
    "Isolated extension fixture",
  ]);
});
test.afterAll(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});
async function capture(page: Page, info: TestInfo, name: string) {
  const filename = info.outputPath(`${name}.png`);
  await page.screenshot({ path: filename, fullPage: true });
  await info.attach(name, { path: filename, contentType: "image/png" });
}
async function focusEditor(page: Page) {
  await page.evaluate(async () => {
    const modulePath = "/src/components/codeEditor/editorRuntime.ts";
    const { monaco } = await import(/* @vite-ignore */ modulePath);
    const editor = monaco.editor
      .getEditors()
      .find(
        (candidate: { getModel(): { uri: { scheme: string } } | null }) =>
          candidate.getModel()?.uri.scheme === "synara-workspace",
      );
    if (!editor) throw new Error("Native Synara editor is not mounted.");
    editor.focus();
  });
}
async function command(page: Page, name: string) {
  await focusEditor(page);
  await page.keyboard.press("F1");
  await page.getByRole("combobox", { name: "Editor commands" }).fill(name);
  await page.getByRole("option", { name, exact: false }).click();
}
async function bridgePhase(page: Page) {
  return page.evaluate(async () => {
    const runtimePath = "/src/components/codeEditor/editorRuntime.ts";
    const modelsPath = "/src/components/codeEditor/editorModels.ts";
    const bridgePath = "/src/components/codeEditor/editorExtensionBridge.ts";
    const [{ monaco }, { editorEntry }, { getEditorExtensionBridge }] = await Promise.all([
      import(/* @vite-ignore */ runtimePath),
      import(/* @vite-ignore */ modelsPath),
      import(/* @vite-ignore */ bridgePath),
    ]);
    const model = monaco.editor
      .getModels()
      .find(
        (candidate: { uri: { scheme: string } }) => candidate.uri.scheme === "synara-workspace",
      );
    const entry = model && editorEntry(model);
    if (!entry?.cwd) throw new Error("Native workspace model is unavailable.");
    const state = getEditorExtensionBridge(entry.client, entry.cwd).getSnapshot();
    if (state.phase === "failed") throw new Error(state.error ?? "Extension host failed.");
    return state.phase;
  });
}

test("native settings, actual extension install, sandbox activation, formatting and undo", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const threadId = await seedEditorProject(page, cwd);
  try {
    await page.goto("/settings?section=extensions");
    await expect(page.getByText("No editor extensions installed.", { exact: true })).toBeVisible();
    await capture(page, info, "before-install-native-extension-settings");
    await page.getByRole("textbox", { name: "Search Open VSX" }).fill("esbenp.prettier-vscode");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const result = page
      .locator('[data-slot="settings-row"]')
      .filter({ hasText: "esbenp.prettier-vscode" });
    await expect(result).toHaveCount(1, { timeout: 35_000 });
    await expect(result.getByRole("button", { name: "Install compatible version" })).toBeVisible();
    await capture(page, info, "after-real-open-vsx-search");
    await result.getByRole("button", { name: "Install compatible version" }).click();
    const installed = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Installed extensions", exact: true }) });
    await expect(installed).toContainText("esbenp.prettier-vscode", { timeout: 90_000 });
    await expect(installed.getByRole("button", { name: "Enable", exact: true })).toBeEnabled();
    await capture(page, info, "after-vsix-validation-installed-disabled");
    await installed.getByRole("button", { name: "Enable", exact: true }).click();
    const approval = page.getByRole("alertdialog");
    await expect(approval).toContainText("SHA-256");
    await capture(page, info, "after-explicit-extension-code-consent");
    await approval.getByRole("button", { name: "Enable approved versions" }).click();
    await expect(installed.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
    await expect(approval).not.toBeVisible();
    await page.getByRole("textbox", { name: "Workspace directory" }).fill(cwd);
    await page.getByRole("button", { name: "Trust workspace", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Trust workspace", exact: true })
      .click();
    await expect(page.getByRole("button", { name: "Revoke trust", exact: true })).toBeVisible();
    await capture(page, info, "after-installed-extension-and-workspace-trust");

    await page.goto(`/${threadId}?view=editor&editorFilePath=example.js`);
    await page.getByRole("button", { name: "Edit file", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Edit example.js", exact: true });
    await expect(input).toBeAttached();
    await expect(page.locator(".monaco-editor").filter({ has: input })).toBeVisible();
    await command(page, "Start approved extensions");
    await expect.poll(() => bridgePhase(page), { timeout: 45_000 }).toBe("running");
    await capture(page, info, "before-format-real-synara-editor");
    await command(page, "Format with extension");
    await expect(page.getByRole("dialog")).toContainText("Prettier");
    await capture(page, info, "after-real-prettier-provider-in-native-picker");
    await page.getByRole("option", { name: /Prettier/ }).click();
    await expect.poll(() => readFile(path.join(cwd, "example.js"), "utf8")).toBe(after);
    await capture(page, info, "after-prettier-format-native-save");
    await command(page, "Undo");
    await expect.poll(() => readFile(path.join(cwd, "example.js"), "utf8")).toBe(before);
    await command(page, "Redo");
    await expect.poll(() => readFile(path.join(cwd, "example.js"), "utf8")).toBe(after);
    await command(page, "Stop extensions");
    await expect.poll(() => bridgePhase(page)).toBe("stopped");
    await capture(page, info, "after-extension-cleanup-native-editor-retained");
    const evidence = await page.evaluate(async () => {
      const modulePath = "/src/nativeApi.ts";
      const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
      const state = await ensureNativeApi().editor.extensions({ operation: "list" });
      return {
        apiVersion: state.apiVersion,
        runtime: state.runtime,
        extensions: state.extensions.map(
          (entry: { id: string; version: string; digest: string }) => ({
            id: entry.id,
            version: entry.version,
            digest: entry.digest,
          }),
        ),
      };
    });
    await info.attach("actual-extension-evidence", {
      body: JSON.stringify(evidence, null, 2),
      contentType: "application/json",
    });
    expect(errors).toEqual([]);
  } catch (error) {
    console.error(
      "NATIVE_EXTENSION_UI_FAILURE",
      (await page.locator("body").innerText()).slice(-16_000),
    );
    throw error;
  } finally {
    await page.evaluate(async (workspace) => {
      const modulePath = "/src/nativeApi.ts";
      const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
      await ensureNativeApi().editor.extensions({
        operation: "setTrust",
        cwd: workspace,
        trusted: false,
      });
    }, cwd);
  }
});

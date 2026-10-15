import { expect, type Page } from "playwright/test";

export async function seedEditorProject(page: Page, workspace: string): Promise<string> {
  await page.goto("/");
  // Fail at bootstrap rather than sending a command into a disconnected transport.
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const modulePath = "/src/nativeApi.ts";
          const { ensureNativeApi, readNativeApiServerCapability } = await import(
            /* @vite-ignore */ modulePath
          );
          ensureNativeApi();
          return readNativeApiServerCapability("rpc.typed-errors");
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  // The welcome tour suppresses the separate import announcement for new users.
  // Dismiss the real tour rather than waiting for an intentionally absent dialog.
  const welcome = page.getByRole("dialog", { name: "Welcome to Synara", exact: true });
  const skipTour = welcome.getByRole("button", { name: "Skip setup", exact: true });
  await expect(skipTour).toBeVisible();
  await skipTour.click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  return page.evaluate(async (cwd) => {
    const modulePath = "/src/nativeApi.ts";
    const { ensureNativeApi } = await import(/* @vite-ignore */ modulePath);
    const api = ensureNativeApi();
    const now = new Date().toISOString();
    const projectId = crypto.randomUUID();
    const threadId = crypto.randomUUID();
    await api.orchestration.dispatchCommand({
      type: "project.create",
      commandId: crypto.randomUUID(),
      projectId,
      title: "Editor acceptance",
      workspaceRoot: cwd,
      createdAt: now,
    });
    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: crypto.randomUUID(),
      threadId,
      projectId,
      title: "Native editor intelligence",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      createdAt: now,
    });
    // No turn is submitted: model metadata does not start a provider or send project data.
    return threadId;
  }, workspace);
}

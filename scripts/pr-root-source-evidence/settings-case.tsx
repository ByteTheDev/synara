
it("saves raw Codex launch args without changing account paths", async () => {
  const updateSettings = vi.fn();
  const binaryPath = "/custom/codex";
  const homePath = "/custom/codex-home";
  await render(
    <ProvidersSettingsPanel
      {...props}
      settings={{ ...defaults, codexBinaryPath: binaryPath, codexHomePath: homePath }}
      updateSettings={updateSettings}
    />,
  );
  const details = page.getByRole("button", { name: /^Codex Custom/u });
  if (details.element().getAttribute("aria-expanded") === "false") await details.click();
  const account = page.getByRole("group", { name: "Codex account", exact: true });
  const args = account.getByRole("textbox", { name: /^Codex launch args/u });
  const launchArgs = ' -c model_provider="api token" -- --value trailing\\ ';
  await args.fill(launchArgs);
  await userEvent.tab();
  await expect
    .poll(() => updateSettings.mock.calls.at(-1)?.[0])
    .toEqual({ codexLaunchArgs: launchArgs });
  await expect
    .element(account.getByRole("textbox", { name: /^Codex binary path/u }))
    .toHaveValue(binaryPath);
  await expect
    .element(account.getByRole("textbox", { name: /^CODEX_HOME path/u }))
    .toHaveValue(homePath);
});

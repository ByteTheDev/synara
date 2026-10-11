async function captureRootProviderSettings(stage: string) {
  const directory = import.meta.env.VITE_PR_ROOT_OUTPUT;
  if (!directory?.startsWith("/")) throw new Error("Missing owned settings image destination.");
  const account = page.getByRole("group", { name: "Codex account", exact: true }).element();
  account.scrollIntoView({ block: "center" });
  await document.fonts.ready;
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const fields = [...account.querySelectorAll<HTMLInputElement>("input")].map((input) => ({
    label: input.getAttribute("aria-label") ?? [...(input.labels ?? [])].map((label) => label.textContent?.trim() ?? "").join(" "),
    value: input.value, placeholder: input.placeholder,
  }));
  await page.screenshot({ path: directory + "/settings-" + stage + ".png" });
  console.log("PR_ROOT_OBSERVATION " + JSON.stringify({
    stage: "settings-" + stage, source: import.meta.env.VITE_PR_ROOT_SOURCE,
    sourceTree: import.meta.env.VITE_PR_ROOT_TREE,
    viewport: { width: window.innerWidth, height: window.innerHeight }, fields,
    accountText: account.textContent,
    qualification: "Actual ProvidersSettingsPanel under its canonical controlled native/status fixture, no packaged desktop or live account claim.",
  }));
}


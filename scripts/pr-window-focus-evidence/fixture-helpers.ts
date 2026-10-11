async function captureWindowActivation(label: string, stage: string) {
  const directory = import.meta.env.VITE_PR_FOCUS_OUTPUT;
  const variant = import.meta.env.VITE_PR_FOCUS_VARIANT;
  const source = import.meta.env.VITE_PR_FOCUS_SOURCE;
  if (!directory?.startsWith("/") || !["before", "after"].includes(variant))
    throw new Error("An explicit first-activation evidence target is required.");
  const picker = label === "Change model and reasoning" ? "model" : "permissions";
  if (!["Change model and reasoning", "Full access"].includes(label))
    throw new Error("Unexpected first-activation control.");
  await document.fonts.ready;
  await waitForLayout();
  const active = document.activeElement;
  const trigger = page.getByRole("button", { name: label, exact: true }).element();
  const observation = {
    phase: `${picker}-${stage}`,
    source,
    variant,
    label,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentFocused: document.hasFocus(),
    editorFocused: active === document.querySelector('[data-testid="composer-editor"]'),
    activeElement: active
      ? {
          tag: active.tagName,
          role: active.getAttribute("role"),
          label: active.getAttribute("aria-label"),
          editable: active.getAttribute("contenteditable"),
        }
      : null,
    expanded: trigger.getAttribute("aria-expanded"),
    visibleMenus: [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
      .filter((element) =>
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      )
      .map((element) => element.textContent),
  };
  await page.screenshot({ path: `${directory}/${observation.phase}.png` });
  console.log("PR_FOCUS_OBSERVATION " + JSON.stringify(observation));
}

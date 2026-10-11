async function captureActivityGroupingEvidence(phase: string) {
  const directory = import.meta.env.VITE_PR_GROUPING_OUTPUT;
  const variant = import.meta.env.VITE_PR_GROUPING_VARIANT;
  const source = import.meta.env.VITE_PR_GROUPING_SOURCE;
  if (!directory?.startsWith("/") || !["before", "after"].includes(variant)) {
    throw new Error("An explicit grouping evidence target is required.");
  }
  await document.fonts.ready;
  await waitForLayout();
  const observation = {
    phase,
    variant,
    source,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentClass: document.documentElement.className,
    menuChoices: Array.from(document.querySelectorAll('[role="menuitemradio"]')).map((element) => ({
      text: element.textContent,
      checked: element.getAttribute("aria-checked"),
    })),
    storedSidebarState: JSON.parse(localStorage.getItem("synara:sidebar-ui:v1") ?? "null"),
  };
  await page.screenshot({ path: `${directory}/${phase}.png` });
  console.log("PR_GROUPING_OBSERVATION " + JSON.stringify(observation));
}

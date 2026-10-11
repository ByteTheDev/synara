async function captureSidebarThreadEvidence(phase: string, route: string) {
  const directory = import.meta.env.VITE_PR_SIDEBAR_OUTPUT;
  const variant = import.meta.env.VITE_PR_SIDEBAR_VARIANT;
  const source = import.meta.env.VITE_PR_SIDEBAR_SOURCE;
  if (!directory?.startsWith("/") || !["before", "after"].includes(variant)) {
    throw new Error("An explicit Sidebar evidence target is required.");
  }
  await document.fonts.ready;
  await waitForLayout();
  const draftState = useComposerDraftStore.getState();
  const observation = {
    phase,
    variant,
    source,
    route,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentClass: document.documentElement.className,
    threadsHydrated: useStore.getState().threadsHydrated,
    projectCount: useStore.getState().projects.length,
    projectEnvironments: useProjectEnvironmentStore.getState().envModeByProjectId,
    drafts: Object.entries(draftState.draftThreadsByThreadId).map(([threadId, draft]) => ({
      threadId,
      projectId: draft.projectId,
      envMode: draft.envMode,
      entryPoint: draft.entryPoint,
    })),
    routedDraftPrompt: draftState.draftsByThreadId[route.slice(1) as ThreadId]?.prompt ?? null,
    worktreeCheckboxChecked:
      document
        .querySelector('[data-empty-landing-controls] [data-slot="checkbox"]')
        ?.getAttribute("aria-checked") ?? null,
    loadingProjects: document.querySelector('[aria-label="Loading projects"]') !== null,
    visibleDialogText: document.querySelector('[role="dialog"]')?.textContent ?? null,
  };
  await page.screenshot({ path: `${directory}/${phase}.png` });
  console.log("PR_SIDEBAR_OBSERVATION " + JSON.stringify(observation));
}

type ModelEvidenceScenario = {
  id: "configured" | "sibling" | "unknown";
  instanceId: "claude_work" | "claude_empty";
  model: string;
  accountName: "Work" | "Empty";
};

let modelEvidenceActive = false;

function modelEvidenceServerSettings() {
  const settings = createBrowserTestServerSettings(NOW_ISO);
  return {
    ...settings,
    providers: {
      ...settings.providers,
      claudeAgent: { ...settings.providers.claudeAgent, customModels: ["personal-only"] },
    },
    providerInstances: {
      ...settings.providerInstances,
      claude_work: {
        driver: "claudeAgent",
        displayName: "Work",
        config: { customModels: ["enterprise-model"] },
      },
      claude_empty: {
        driver: "claudeAgent",
        displayName: "Empty",
        config: { customModels: [] },
      },
    },
  };
}

function configureModelEvidenceProviders(target: TestFixture) {
  const providers = [
    ...target.serverConfig.providers.filter((provider) => provider.provider !== "claudeAgent"),
    ...(["claudeAgent", "claude_work", "claude_empty"] as const).map((instanceId) => ({
      provider: "claudeAgent" as const,
      instanceId,
      driver: "claudeAgent" as const,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      checkedAt: NOW_ISO,
    })),
  ];
  target.serverConfig = { ...target.serverConfig, providers };
  target.providerStatusesSnapshot = providers;
}

function modelEvidenceSnapshot(scenario: ModelEvidenceScenario): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: MessageId.makeUnsafe(`model-evidence-${scenario.id}`),
    targetText: `Review the ${scenario.model} settings for the ${scenario.accountName} account.`,
  });
  const modelSelection = {
    provider: "claudeAgent" as const,
    instanceId: scenario.instanceId,
    model: scenario.model,
  };
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      defaultModelSelection: modelSelection,
    })),
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      modelSelection,
      session: {
        ...thread.session!,
        providerName: "claudeAgent",
        providerInstanceId: scenario.instanceId,
      },
    })),
  };
}

function modelEvidenceSelection(scenario: ModelEvidenceScenario) {
  return useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider[
    scenario.instanceId
  ];
}

function modelEvidencePersistedSelection(scenario: ModelEvidenceScenario) {
  return JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "null")?.state
    ?.draftsByThreadId[THREAD_ID]?.modelSelectionByProvider[scenario.instanceId];
}

async function mountModelEvidence(scenario: ModelEvidenceScenario, seedSelection = true) {
  modelEvidenceActive = true;
  localStorage.setItem("synara:app-settings:v1", JSON.stringify({ composerEffortSlider: false }));
  if (seedSelection) {
    useComposerDraftStore.getState().setModelSelection(THREAD_ID, {
      provider: "claudeAgent",
      instanceId: scenario.instanceId,
      model: scenario.model,
    });
  }
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot: modelEvidenceSnapshot(scenario),
    configureFixture: configureModelEvidenceProviders,
  });
  try {
    const trigger = page.getByRole("button", { name: "Change model and reasoning" });
    await expect.element(trigger).toBeVisible();
    await expect.element(trigger).toHaveTextContent(scenario.accountName);
    await expect
      .element(trigger)
      .toHaveTextContent(scenario.id === "unknown" ? /unknown/iu : /enterprise/iu);
    expect(modelEvidenceSelection(scenario)).toMatchObject({
      provider: "claudeAgent",
      instanceId: scenario.instanceId,
      model: scenario.model,
    });
    return mounted;
  } catch (cause) {
    await mounted.cleanup();
    throw cause;
  }
}

async function openModelEvidenceMenu() {
  await page.getByRole("button", { name: "Change model and reasoning" }).click();
  await expect.element(page.getByRole("searchbox", { name: "Search models" })).toBeVisible();
}

async function captureModelEvidence(
  scenario: ModelEvidenceScenario,
  phase: string,
  route: string,
  extra: Record<string, unknown> = {},
) {
  const directory = import.meta.env.VITE_PR_MODEL_OUTPUT;
  const variant = import.meta.env.VITE_PR_MODEL_VARIANT;
  const source = import.meta.env.VITE_PR_MODEL_SOURCE;
  if (!directory?.startsWith("/") || !["before", "after"].includes(variant))
    throw new Error("An explicit full-ChatView model evidence target is required.");
  await document.fonts.ready;
  await waitForLayout();
  const observation = {
    scenario,
    phase,
    source,
    variant,
    route,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentClass: document.documentElement.className,
    selection: modelEvidenceSelection(scenario),
    persistedSelection: modelEvidencePersistedSelection(scenario),
    prompt: useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt,
    triggerText: page.getByRole("button", { name: "Change model and reasoning" }).element()
      .textContent,
    visibleMenuRows: [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'),
    ]
      .filter((element) =>
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      )
      .map((element) => ({
        text: element.textContent,
        checked: element.getAttribute("aria-checked"),
      })),
    settingsRequests: wsRequests.filter((request) => request._tag === WS_METHODS.serverGetSettings)
      .length,
    providerModelRequests: wsRequests
      .filter((request) => request._tag === WS_METHODS.providerListModels)
      .map(({ provider, instanceId, refresh }) => ({ provider, instanceId, refresh })),
    ...extra,
  };
  await page.screenshot({ path: `${directory}/${phase}.png` });
  console.log("PR_MODEL_OBSERVATION " + JSON.stringify(observation));
}

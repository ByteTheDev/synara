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

let modelEvidenceOpenAttempt = 0;

async function openModelEvidenceMenu() {
  const attempt = ++modelEvidenceOpenAttempt;
  const started = performance.now();
  const records: Record<string, unknown>[] = [];
  const describeElement = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return target === window ? "window" : null;
    const bounds = target.getBoundingClientRect();
    return {
      tag: target.tagName,
      role: target.getAttribute("role"),
      label: target.getAttribute("aria-label"),
      editable: target.getAttribute("contenteditable"),
      text: target.textContent?.slice(0, 180),
      connected: target.isConnected,
      rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    };
  };
  const snapshot = () => {
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Change model and reasoning"]',
    );
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search models"]');
    return {
      documentFocused: document.hasFocus(),
      active: describeElement(document.activeElement),
      trigger: describeElement(trigger),
      disabled: trigger?.disabled,
      expanded: trigger?.getAttribute("aria-expanded"),
      open: trigger?.getAttribute("data-popup-open"),
      search: describeElement(search),
      searchVisible: search?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
    };
  };
  const record = (stage: string, extra: Record<string, unknown> = {}) => {
    if (records.length < 160)
      records.push({ stage, elapsedMs: performance.now() - started, ...snapshot(), ...extra });
  };
  const onEvent = (event: Event) => {
    record(event.type, {
      target: describeElement(event.target),
      defaultPrevented: event.defaultPrevented,
      ...(event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : {}),
      ...(event instanceof FocusEvent ? { related: describeElement(event.relatedTarget) } : {}),
    });
  };
  const events = [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
    "focusin",
    "focusout",
  ];
  for (const event of events) document.addEventListener(event, onEvent, true);
  window.addEventListener("focus", onEvent);
  window.addEventListener("blur", onEvent);
  let lastState = JSON.stringify(snapshot());
  const observer = new MutationObserver(() => {
    const current = JSON.stringify(snapshot());
    if (current !== lastState) {
      lastState = current;
      record("surface-change");
    }
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "data-popup-open", "data-state", "style", "class"],
  });
  record("before-click");
  try {
    await page.getByRole("button", { name: "Change model and reasoning" }).click();
    record("click-returned");
    await expect.element(page.getByRole("searchbox", { name: "Search models" })).toBeVisible();
    record("search-visible");
  } catch (cause) {
    record("original-assertion-failed", { cause: String(cause) });
    try {
      await page.screenshot({
        path: `${import.meta.env.VITE_PR_MODEL_OUTPUT}/model-menu-open-failure-${attempt}.png`,
      });
    } catch (screenshotError) {
      record("failure-screenshot-error", { cause: String(screenshotError) });
    }
    throw cause;
  } finally {
    observer.disconnect();
    for (const event of events) document.removeEventListener(event, onEvent, true);
    window.removeEventListener("focus", onEvent);
    window.removeEventListener("blur", onEvent);
    console.log("PR_MODEL_MENU_OBSERVER " + JSON.stringify({ attempt, records }));
  }
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

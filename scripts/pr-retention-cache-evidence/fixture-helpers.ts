let retentionEvidenceServerSettings: ReturnType<typeof createBrowserTestServerSettings> | null =
  null;

function retentionEvidenceSettings(cacheOptIn = false) {
  const settings = createBrowserTestServerSettings(NOW_ISO);
  return {
    ...settings,
    providers: {
      ...settings.providers,
      claudeAgent: { ...settings.providers.claudeAgent, confirmColdCacheResume: cacheOptIn },
    },
  };
}

function configureRetentionEvidenceProvider(target: TestFixture) {
  const providers = [
    ...target.serverConfig.providers.filter((provider) => provider.provider !== "claudeAgent"),
    {
      provider: "claudeAgent" as const,
      instanceId: "claudeAgent",
      driver: "claudeAgent" as const,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      checkedAt: NOW_ISO,
    },
  ];
  target.serverConfig = { ...target.serverConfig, providers };
  target.providerStatusesSnapshot = providers;
}

async function captureRetentionEvidence(
  phase: string,
  route: string,
  extra: Record<string, unknown> = {},
) {
  const directory = import.meta.env.VITE_PR_RETENTION_OUTPUT;
  const variant = import.meta.env.VITE_PR_RETENTION_VARIANT;
  const source = import.meta.env.VITE_PR_RETENTION_SOURCE;
  if (!directory?.startsWith("/") || !["before", "after"].includes(variant))
    throw new Error("An explicit full-ChatView retention evidence target is required.");
  await document.fonts.ready;
  await waitForLayout();
  const observation = {
    phase,
    source,
    variant,
    route,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    documentClass: document.documentElement.className,
    controlledSettings: retentionEvidenceServerSettings,
    buttons: [...document.querySelectorAll<HTMLButtonElement>("button")]
      .filter((element) =>
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      )
      .map((element) => ({ text: element.textContent, disabled: element.disabled })),
    switches: [...document.querySelectorAll<HTMLElement>('[role="switch"]')]
      .filter((element) =>
        element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      )
      .map((element) => ({
        id: element.id,
        label: element.getAttribute("aria-label"),
        checked: element.getAttribute("aria-checked"),
      })),
    ...extra,
  };
  await page.screenshot({ path: `${directory}/${phase}.png` });
  console.log("PR_RETENTION_OBSERVATION " + JSON.stringify(observation));
}

function restoreRetentionNativeApi(previous: typeof window.nativeApi) {
  if (previous) Object.defineProperty(window, "nativeApi", { configurable: true, value: previous });
  else delete window.nativeApi;
}

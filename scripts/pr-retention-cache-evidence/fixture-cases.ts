it("qualifies the current retention Never choice through the real Settings route", async () => {
  retentionEvidenceServerSettings = retentionEvidenceSettings();
  localStorage.setItem("synara:server-settings-migrated:v1", "1");
  const mounted = await mountChatView({
    viewport: { ...DEFAULT_VIEWPORT, width: 960, height: 1100 },
    snapshot: createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("retention-current-settings"),
      targetText: "Review the archive window",
    }),
  });
  const previous = window.nativeApi;
  const api = readNativeApi();
  if (!api) throw new Error("Expected the existing controlled browser API fixture.");
  const updateSettings = vi.fn(async (patch: Parameters<typeof api.server.updateSettings>[0]) => {
    expect(Object.keys(patch)).toEqual(["threadAutoArchive"]);
    expect(patch.threadAutoArchive).toBe("never");
    retentionEvidenceServerSettings = {
      ...retentionEvidenceServerSettings!,
      threadAutoArchive: patch.threadAutoArchive!,
    };
    return retentionEvidenceServerSettings;
  });
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { ...api, server: { ...api.server, updateSettings } },
  });
  try {
    await mounted.router.navigate({ to: "/settings", search: { section: "behavior" } });
    const heading = page.getByRole("heading", { name: "Conversation", exact: true });
    await expect.element(heading).toBeVisible();
    const neighbor = page.getByText("Side chat expiry", { exact: true });
    await expect.element(neighbor).toBeInTheDocument();
    neighbor.element().scrollIntoView({ block: "center", behavior: "instant" });
    await captureRetentionEvidence("conversation-default", mounted.router.state.location.pathname);
    const retention = page.getByRole("radiogroup", { name: "Archive idle threads", exact: true });
    await expect
      .element(retention.getByRole("radio", { name: "7 days", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await retention.getByRole("radio", { name: "Never", exact: true }).click();
    await expect.poll(() => updateSettings.mock.calls.length).toBe(1);
    await expect
      .element(retention.getByRole("radio", { name: "Never", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    expect(retentionEvidenceServerSettings.threadAutoArchive).toBe("never");
    await captureRetentionEvidence("conversation-never", mounted.router.state.location.pathname, {
      settingsUpdates: updateSettings.mock.calls,
    });
  } finally {
    await mounted.cleanup();
    restoreRetentionNativeApi(previous);
    retentionEvidenceServerSettings = null;
  }
});

it("preserves the canonical provider-scoped cache setting and its off default", async () => {
  retentionEvidenceServerSettings = retentionEvidenceSettings();
  localStorage.setItem("synara:server-settings-migrated:v1", "1");
  const mounted = await mountChatView({
    viewport: { ...DEFAULT_VIEWPORT, width: 960, height: 1100 },
    snapshot: createSnapshotForTargetUser({
      targetMessageId: MessageId.makeUnsafe("retention-current-provider"),
      targetText: "Review the provider cache preference",
    }),
    configureFixture: configureRetentionEvidenceProvider,
  });
  const previous = window.nativeApi;
  const api = readNativeApi();
  if (!api) throw new Error("Expected the existing controlled browser API fixture.");
  const updateSettings = vi.fn(async (patch: Parameters<typeof api.server.updateSettings>[0]) => {
    expect(Object.keys(patch)).toEqual(["providers"]);
    expect(Object.keys(patch.providers ?? {})).toEqual(["claudeAgent"]);
    expect(Object.keys(patch.providers?.claudeAgent ?? {})).toEqual(["confirmColdCacheResume"]);
    const checked = patch.providers?.claudeAgent?.confirmColdCacheResume;
    expect(typeof checked).toBe("boolean");
    const saved = retentionEvidenceServerSettings!;
    retentionEvidenceServerSettings = {
      ...saved,
      providers: {
        ...saved.providers,
        claudeAgent: { ...saved.providers.claudeAgent, confirmColdCacheResume: checked! },
      },
    };
    return retentionEvidenceServerSettings;
  });
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { ...api, server: { ...api.server, updateSettings } },
  });
  try {
    await mounted.router.navigate({
      to: "/settings",
      search: { section: "providers", provider: "claudeAgent" },
    });
    const control = page.getByRole("switch", { name: /^Ask before resuming a long idle session/u });
    await expect.element(control).toBeInTheDocument();
    control.element().closest("label")!.scrollIntoView({ block: "center", behavior: "instant" });
    await expect.element(control).toBeVisible();
    await expect.element(control).toHaveAttribute("aria-checked", "false");
    await captureRetentionEvidence("provider-default-off", mounted.router.state.location.pathname);
    await control.click();
    await expect.poll(() => updateSettings.mock.calls.length).toBe(1);
    await expect.element(control).toHaveAttribute("aria-checked", "true");
    expect(retentionEvidenceServerSettings.providers.claudeAgent.confirmColdCacheResume).toBe(true);
    await captureRetentionEvidence("provider-opted-in", mounted.router.state.location.pathname, {
      settingsUpdates: updateSettings.mock.calls,
    });
    await control.click();
    await expect.poll(() => updateSettings.mock.calls.length).toBe(2);
    await expect.element(control).toHaveAttribute("aria-checked", "false");
    expect(retentionEvidenceServerSettings.providers.claudeAgent.confirmColdCacheResume).toBe(
      false,
    );
    await captureRetentionEvidence("provider-opted-out", mounted.router.state.location.pathname, {
      settingsUpdates: updateSettings.mock.calls,
    });
  } finally {
    await mounted.cleanup();
    restoreRetentionNativeApi(previous);
    retentionEvidenceServerSettings = null;
  }
});

it("reports the real cache preference write failure after an accepted full-ChatView choice", async () => {
  retentionEvidenceServerSettings = retentionEvidenceSettings(true);
  localStorage.setItem("synara:server-settings-migrated:v1", "1");
  const messageId = MessageId.makeUnsafe("retention-current-cache-message");
  const review = {
    reviewId: "retention-current-cache-review",
    messageId,
    sourceEventSequence: 1,
    assessment: {
      observedAt: NOW_ISO,
      lastResponseAt: new Date(Date.parse(NOW_ISO) - 2 * 60 * 60 * 1000).toISOString(),
      state: "likely-expired",
      source: "request-usage",
      contextTokens: 161_000,
    },
    status: "pending",
    createdAt: NOW_ISO,
  } as const;
  const base = createSnapshotForTargetUser({
    targetMessageId: messageId,
    targetText: "Please resume this held message with the existing context.",
  });
  const modelSelection = {
    provider: "claudeAgent",
    instanceId: "claudeAgent",
    model: "claude-opus-4-6",
  } as const;
  const snapshot: OrchestrationReadModel = {
    ...base,
    projects: base.projects.map((project) => ({
      ...project,
      defaultModelSelection: modelSelection,
    })),
    threads: base.threads.map((thread) => ({
      ...thread,
      modelSelection,
      claudeCacheReview: review,
      session: {
        ...thread.session!,
        providerName: "claudeAgent",
        providerInstanceId: "claudeAgent",
      },
    })),
  };
  const mounted = await mountChatView({
    viewport: { ...DEFAULT_VIEWPORT, width: 960, height: 1100 },
    snapshot,
    configureFixture: configureRetentionEvidenceProvider,
  });
  const previous = window.nativeApi;
  const api = readNativeApi();
  if (!api) throw new Error("Expected the existing controlled browser API fixture.");
  let acceptChoice!: () => void;
  const acknowledgement = new Promise<void>((resolve) => {
    acceptChoice = resolve;
  });
  let rejectSave!: (cause: Error) => void;
  const saving = new Promise<void>((_resolve, reject) => {
    rejectSave = reject;
  });
  let savingSettled = false;
  let savingRequested = false;
  let cleaningUp = false;
  const cacheRespond = vi.fn(
    async (command: Parameters<typeof api.orchestration.dispatchCommand>[0]) => {
      expect(command).toMatchObject({
        type: "thread.claude-cache.respond",
        threadId: THREAD_ID,
        messageId,
        reviewId: review.reviewId,
        decision: "continue",
      });
      await acknowledgement;
      return { sequence: snapshot.snapshotSequence + 1 };
    },
  );
  const updateSettings = vi.fn(async (patch: Parameters<typeof api.server.updateSettings>[0]) => {
    expect(patch).toEqual({ providers: { claudeAgent: { confirmColdCacheResume: false } } });
    if (cleaningUp) throw new Error("Controlled fixture cleanup");
    savingRequested = true;
    try {
      await saving;
    } finally {
      savingSettled = true;
    }
    return retentionEvidenceServerSettings!;
  });
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: {
      ...api,
      server: { ...api.server, updateSettings },
      orchestration: {
        ...api.orchestration,
        dispatchCommand: (command: Parameters<typeof api.orchestration.dispatchCommand>[0]) =>
          command.type === "thread.claude-cache.respond"
            ? cacheRespond(command)
            : api.orchestration.dispatchCommand(command),
      },
    },
  });
  try {
    const choice = page.getByRole("button", { name: /^Don\x27t ask me again/u });
    await expect.element(choice).toBeVisible();
    await expect
      .element(page.getByText("This session is 2 hours old and 161k tokens.", { exact: true }))
      .toBeVisible();
    await captureRetentionEvidence("cache-review-options", mounted.router.state.location.pathname);
    await choice.click();
    expect(cacheRespond).toHaveBeenCalledTimes(1);
    expect(updateSettings).not.toHaveBeenCalled();
    await expect.element(choice).toBeDisabled();
    await captureRetentionEvidence("cache-choice-pending", mounted.router.state.location.pathname, {
      cacheResponses: cacheRespond.mock.calls,
      settingsUpdates: updateSettings.mock.calls,
    });
    acceptChoice();
    await expect.poll(() => updateSettings.mock.calls.length).toBe(1);
    await expect.element(choice).toBeDisabled();
    expect(retentionEvidenceServerSettings.providers.claudeAgent.confirmColdCacheResume).toBe(true);
    await captureRetentionEvidence(
      "cache-preference-saving",
      mounted.router.state.location.pathname,
      { cacheResponses: cacheRespond.mock.calls, settingsUpdates: updateSettings.mock.calls },
    );
    rejectSave(new Error("Controlled settings RPC failure"));
    await expect.poll(() => savingSettled).toBe(true);
    await captureRetentionEvidence(
      "cache-preference-failed",
      mounted.router.state.location.pathname,
      { cacheResponses: cacheRespond.mock.calls, settingsUpdates: updateSettings.mock.calls },
    );
    await expect
      .element(page.getByText("Cache preference not saved", { exact: true }))
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "Your current choice was accepted. Future cache confirmations may still appear. Change the preference in Settings.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect.element(choice).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: /^Resume full session as-is/u }))
      .toBeDisabled();
    expect(cacheRespond).toHaveBeenCalledTimes(1);
    expect(updateSettings).toHaveBeenCalledTimes(1);
    expect(retentionEvidenceServerSettings.providers.claudeAgent.confirmColdCacheResume).toBe(true);
  } finally {
    cleaningUp = true;
    acceptChoice();
    // Reject only an already requested write, so failed setup never creates an unhandled promise.
    if (savingRequested && !savingSettled) rejectSave(new Error("Controlled fixture cleanup"));
    await mounted.cleanup();
    restoreRetentionNativeApi(previous);
    retentionEvidenceServerSettings = null;
  }
});

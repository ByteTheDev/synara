it("qualifies configured Claude options in the full ChatView", async () => {
  const scenario: ModelEvidenceScenario = {
    id: "configured",
    instanceId: "claude_work",
    model: "enterprise-model",
    accountName: "Work",
  };
  let mounted: MountedChatView | undefined;
  try {
    mounted = await mountModelEvidence(scenario);
    await captureModelEvidence(
      scenario,
      "configured-thread",
      mounted.router.state.location.pathname,
    );
    await openModelEvidenceMenu();
    await captureModelEvidence(scenario, "configured-menu", mounted.router.state.location.pathname);
    const effort = page.getByRole("menuitem", { name: /^Effort/u });
    const budget = page.getByRole("menuitem", { name: /^Auto-compact/u });
    await expect.element(effort).toBeVisible();
    await expect.element(effort).toHaveTextContent("Auto (Claude Code)");
    await expect.element(budget).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: /^Speed/u })).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("menuitem", { name: /^Thinking/u }))
      .not.toBeInTheDocument();
    await effort.click();
    await expect.element(page.getByRole("menuitemradio", { name: /^High/u })).toBeVisible();
    await captureModelEvidence(
      scenario,
      "configured-effort",
      mounted.router.state.location.pathname,
    );
    await page.getByRole("menuitemradio", { name: /^High/u }).click();
    await expect.poll(() => modelEvidenceSelection(scenario)?.options).toEqual({ effort: "high" });
    await expect.element(effort).toHaveTextContent("High");
    await captureModelEvidence(scenario, "configured-high", mounted.router.state.location.pathname);
    await budget.click();
    await expect
      .element(page.getByRole("menuitemradio", { name: "200k", exact: true }))
      .toBeVisible();
    await captureModelEvidence(
      scenario,
      "configured-budget",
      mounted.router.state.location.pathname,
    );
    await page.getByRole("menuitemradio", { name: "200k", exact: true }).click();
    await expect
      .poll(() => modelEvidenceSelection(scenario)?.options)
      .toEqual({ effort: "high", autoCompactWindow: "200k" });
    await expect.element(budget).toHaveTextContent("200k");
    await captureModelEvidence(
      scenario,
      "configured-high-200k",
      mounted.router.state.location.pathname,
    );
    await effort.click();
    await page.getByRole("menuitemradio", { name: /^Auto \(Claude Code\)/u }).click();
    await expect
      .poll(() => modelEvidenceSelection(scenario)?.options)
      .toEqual({ autoCompactWindow: "200k" });
    await expect
      .poll(() => modelEvidencePersistedSelection(scenario)?.options)
      .toEqual({ autoCompactWindow: "200k" });
    await expect.element(effort).toHaveTextContent("Auto (Claude Code)");
    await captureModelEvidence(
      scenario,
      "configured-auto-200k",
      mounted.router.state.location.pathname,
    );

    // Exercise the actual persistence parser and merge, with a fresh component mount.
    // Keep exactly the bytes produced above; never manufacture a desired stored selection.
    const saved = localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY)!;
    await mounted.cleanup();
    mounted = undefined;
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(modelEvidenceSelection(scenario)).toBeUndefined();
    expect(modelEvidencePersistedSelection(scenario)).toBeUndefined();
    localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, saved);
    expect(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY)).toBe(saved);
    await useComposerDraftStore.persist.rehydrate();
    expect(modelEvidenceSelection(scenario)).toMatchObject({
      provider: "claudeAgent",
      instanceId: "claude_work",
      model: "enterprise-model",
    });
    expect(modelEvidenceSelection(scenario)?.options).toEqual({ autoCompactWindow: "200k" });
    mounted = await mountModelEvidence(scenario, false);
    await openModelEvidenceMenu();
    await expect.element(effort).toHaveTextContent("Auto (Claude Code)");
    await expect.element(budget).toHaveTextContent("200k");
    await captureModelEvidence(
      scenario,
      "configured-rehydrated",
      mounted.router.state.location.pathname,
      {
        actualSavedStorageBytes: saved,
        reloadBoundary:
          "Fresh full ChatView component mount plus actual Zustand rehydration from the unmodified previously persisted bytes; not a browser-process reload.",
      },
    );
    await effort.click();
    await page.getByRole("menuitemradio", { name: "Ultrathink", exact: true }).click();
    await expect
      .poll(() => useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.prompt)
      .toBe("Ultrathink:\n");
    await expect.element(effort).toHaveTextContent("Ultrathink");
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("searchbox", { name: "Search models" }))
      .not.toBeInTheDocument();
    await captureModelEvidence(
      scenario,
      "configured-ultrathink",
      mounted.router.state.location.pathname,
    );
    expect(
      wsRequests.some(
        (request) =>
          request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
          (request.command as { type?: string } | undefined)?.type === "thread.turn.start",
      ),
    ).toBe(false);
  } finally {
    await mounted?.cleanup();
    modelEvidenceActive = false;
  }
});

it.each([
  { id: "sibling", instanceId: "claude_empty", model: "enterprise-model", accountName: "Empty" },
  { id: "unknown", instanceId: "claude_work", model: "unknown-hint", accountName: "Work" },
] as const)(
  "keeps $id Claude model controls unconfigured in the full ChatView",
  async (scenario) => {
    let mounted: MountedChatView | undefined;
    try {
      mounted = await mountModelEvidence(scenario);
      await captureModelEvidence(
        scenario,
        `${scenario.id}-thread`,
        mounted.router.state.location.pathname,
      );
      await openModelEvidenceMenu();
      await captureModelEvidence(
        scenario,
        `${scenario.id}-menu`,
        mounted.router.state.location.pathname,
      );
      await expect
        .element(page.getByRole("menuitem", { name: /^Effort/u }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitem", { name: /^Auto-compact/u }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitem", { name: /^Thinking/u }))
        .not.toBeInTheDocument();
      await expect.element(page.getByRole("menuitem", { name: /^Speed/u })).not.toBeInTheDocument();
      expect(modelEvidenceSelection(scenario)).toMatchObject({
        provider: "claudeAgent",
        instanceId: scenario.instanceId,
        model: scenario.model,
      });
      expect(modelEvidenceSelection(scenario)?.options).toBeUndefined();
      expect(
        wsRequests.some(
          (request) =>
            request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand &&
            (request.command as { type?: string } | undefined)?.type === "thread.turn.start",
        ),
      ).toBe(false);
    } finally {
      await mounted?.cleanup();
      modelEvidenceActive = false;
    }
  },
);

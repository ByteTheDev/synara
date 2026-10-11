describe("PR1858 review evidence", () => {
  it("uses the real retry menu and prior-answer pager", async () => {
    const side = import.meta.env.VITE_PR1858_SIDE;
    const source = import.meta.env.VITE_PR1858_SOURCE;
    const output = import.meta.env.VITE_PR1858_OUTPUT;
    if (
      (side !== "before" && side !== "after") ||
      typeof source !== "string" ||
      !/^[0-9a-f]{40}$/.test(source) ||
      typeof output !== "string" ||
      !output.startsWith("/")
    ) {
      throw new Error("Explicit immutable source, side and screenshot directory are required.");
    }

    const userId = MessageId.makeUnsafe("retry-evidence-user");
    const assistantId = MessageId.makeUnsafe("retry-evidence-medium-assistant");
    const turnId = TurnId.makeUnsafe("retry-evidence-medium-turn");
    const prompt = "Explain the stale-session failure and propose a focused repair.";
    const initialAnswer =
      "The assertion uses an earlier session snapshot. Compare the provider's current session before deciding whether to restart, and add a regression test for a rebind that fails after the projected mode changes.";
    const highAnswer =
      "Read the live session's runtime mode when handling a failed rebind, and compare that same live mode before deciding whether a restart is needed. Preserve the original provider error. Cover both a failed rebind and a stale approval-mode projection with separate regression tests.";
    const checkpointRef = CheckpointRef.makeUnsafe("refs/synara/checkpoints/retry-evidence/turn-1");
    const base = createSnapshotForTargetUser({ targetMessageId: userId, targetText: prompt });
    const snapshot: OrchestrationReadModel = {
      ...base,
      threads: base.threads.map((thread) => ({
        ...thread,
        title: "Review the stale-session failure",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          instanceId: "codex" as NonNullable<
            OrchestrationReadModel["threads"][number]["modelSelection"]["instanceId"]
          >,
          options: { reasoningEffort: "medium", fastMode: true },
        },
        runtimeMode: "approval-required",
        messages: [
          createUserMessage({ id: userId, text: prompt, offsetSeconds: 0 }),
          {
            ...createAssistantMessage({
              id: assistantId,
              text: initialAnswer,
              offsetSeconds: 3,
            }),
            turnId,
          },
        ],
        latestTurn: {
          turnId,
          state: "completed",
          requestedAt: isoAt(0),
          startedAt: isoAt(1),
          completedAt: isoAt(5),
          assistantMessageId: assistantId,
        },
        session: {
          ...thread.session!,
          status: "ready",
          activeTurnId: null,
          runtimeMode: "approval-required",
          updatedAt: isoAt(5),
        },
        checkpoints: [
          {
            turnId,
            checkpointTurnCount: 1,
            checkpointRef,
            status: "ready",
            files: [],
            assistantMessageId: assistantId,
            startedAt: isoAt(1),
            completedAt: isoAt(5),
          },
        ],
        activities: [],
      })),
    };
    expect(snapshot.threads).toHaveLength(1);
    const restoreNativeApi = installDeterministicSendNativeApi();
    const mounted = await mountChatView({ viewport: DEFAULT_VIEWPORT, snapshot });
    const observedPhases: string[] = [];

    async function capture(phase: string): Promise<void> {
      await document.fonts.ready;
      await waitForLayout();
      expect(window.innerWidth).toBe(960);
      expect(window.innerHeight).toBe(1100);
      await page.screenshot({ path: output + "/" + phase + ".png" });
      const retryButton = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Retry with different effort"]',
      );
      const commandTypes = wsRequests
        .map(readDispatchedCommand)
        .filter((command) => command !== null)
        .map((command) => command!.type);
      observedPhases.push(phase);
      console.log(
        "PR1858_OBSERVATION " +
          JSON.stringify({
            side,
            source,
            phase,
            viewport: { width: window.innerWidth, height: window.innerHeight },
            retryButton: retryButton
              ? { disabled: retryButton.disabled, label: retryButton.getAttribute("aria-label") }
              : null,
            dialogText:
              document.querySelector<HTMLElement>('[role="alertdialog"]')?.innerText ?? null,
            menuText: document.querySelector<HTMLElement>('[role="menu"]')?.innerText ?? null,
            pagerText:
              document.querySelector<HTMLElement>('[data-testid="retry-effort-variant-pager"]')
                ?.innerText ?? null,
            visibleText: document.body.innerText.slice(0, 12000),
            commandTypes,
            backendBoundary:
              "Controlled acknowledgement and projected read model; no provider run.",
          }),
      );
    }

    try {
      await waitForServerConfigToApply();
      await expect.element(page.getByText(initialAnswer, { exact: true })).toBeVisible();
      await capture("00-initial");
      await page.getByText(initialAnswer, { exact: true }).hover();
      await capture("01-answer-actions");

      if (side === "before") {
        await expect
          .element(page.getByRole("button", { name: "Retry with different effort", exact: true }))
          .not.toBeInTheDocument();
        expect(hasDispatchedCommandType("thread.message.edit-and-resend")).toBe(false);
        expect(observedPhases).toEqual(["00-initial", "01-answer-actions"]);
        return;
      }

      await expect
        .element(page.getByRole("button", { name: "Retry with different effort", exact: true }))
        .toBeEnabled();
      await page.getByRole("button", { name: "Retry with different effort", exact: true }).click();
      await expect
        .element(page.getByRole("menuitem", { name: /^Medium \(current\)/ }))
        .toBeDisabled();
      await expect.element(page.getByRole("menuitem", { name: /^High(?:\s|$)/ })).toBeEnabled();
      expect(hasDispatchedCommandType("thread.message.edit-and-resend")).toBe(false);
      await capture("02-effort-menu");

      await page.getByRole("menuitem", { name: /^High(?:\s|$)/ }).click();
      await expect.element(page.getByRole("alertdialog")).toBeVisible();
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("checkpoint 0");
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain(
        "pre-retry snapshot",
      );
      expect(hasDispatchedCommandType("thread.message.edit-and-resend")).toBe(false);
      expect(hasDispatchedCommandType("thread.meta.update")).toBe(false);
      await capture("03-confirmation");

      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await vi.waitFor(() => {
        const edits = wsRequests
          .map(readDispatchedCommand)
          .filter((command) => command?.type === "thread.message.edit-and-resend");
        expect(edits).toHaveLength(1);
        expect(edits[0]).toMatchObject({
          messageId: userId,
          text: prompt,
          runtimeMode: "approval-required",
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
            instanceId: "codex",
            options: { reasoningEffort: "high", fastMode: true },
          },
          retryFrom: {
            assistantMessageId: assistantId,
            assistantMessageUpdatedAt: isoAt(4),
            turnId,
            userMessageText: prompt,
            modelSelection: snapshot.threads[0]!.modelSelection,
            checkpointTurnCount: 1,
            checkpointRef,
          },
        });
      });
      await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();

      // This is the explicit component-fixture boundary. The real click above
      // has dispatched and the controlled native API has acknowledged it.
      // Project a subsequent server snapshot to exercise the real transcript
      // and pager. Provider execution and durable writes are not simulated
      // as successful native work; the separate server suite covers them.
      const nextAssistantId = MessageId.makeUnsafe("retry-evidence-high-assistant");
      const nextTurnId = TurnId.makeUnsafe("retry-evidence-high-turn");
      fixture.snapshot = {
        ...snapshot,
        snapshotSequence: snapshot.snapshotSequence + 2,
        threads: snapshot.threads.map((thread) => ({
          ...thread,
          modelSelection: {
            provider: "codex",
            model: "gpt-5.4",
            instanceId: "codex",
            options: { reasoningEffort: "high", fastMode: true },
          },
          messages: [
            thread.messages[0]!,
            {
              ...createAssistantMessage({
                id: nextAssistantId,
                text: highAnswer,
                offsetSeconds: 13,
              }),
              turnId: nextTurnId,
            },
          ],
          latestTurn: {
            turnId: nextTurnId,
            state: "completed",
            requestedAt: isoAt(8),
            startedAt: isoAt(9),
            completedAt: isoAt(15),
            assistantMessageId: nextAssistantId,
          },
          session: { ...thread.session!, updatedAt: isoAt(15) },
          checkpoints: [
            {
              ...thread.checkpoints[0]!,
              turnId: nextTurnId,
              assistantMessageId: nextAssistantId,
              startedAt: isoAt(9),
              completedAt: isoAt(15),
            },
          ],
          activities: [
            {
              id: EventId.makeUnsafe("retry-evidence-receipt"),
              kind: "turn.effort-retry.snapshot",
              summary: "Saved the previous attempt and a pre-retry workspace snapshot.",
              tone: "info",
              turnId: null,
              sequence: snapshot.snapshotSequence + 1,
              sequenceSource: "orchestration",
              createdAt: isoAt(7),
              payload: {
                userMessageId: userId,
                sourceUserMessageText: prompt,
                retryUserMessageText: prompt,
                sourceModelSelection: {
                  provider: "codex",
                  model: "gpt-5.4",
                  instanceId: "codex",
                  options: { reasoningEffort: "medium", fastMode: true },
                },
                assistantMessageId: assistantId,
                assistantMessageText: initialAnswer,
                assistantMessageCreatedAt: isoAt(3),
                sourceTurnId: turnId,
                checkpointTurnCount: 1,
                checkpointRef,
                restoreCheckpointRef: "refs/synara/checkpoints/retry-evidence/turn-0",
                rescueCheckpointRef: "refs/synara/checkpoints/retry-evidence/pre-retry",
              },
            },
          ],
        })),
      };
      useStore.getState().syncServerReadModel(fixture.snapshot);
      await expect.element(page.getByText(highAnswer, { exact: true })).toBeVisible();
      await expect
        .element(page.getByTestId("retry-effort-variant-pager"))
        .toHaveTextContent("2 / 2");
      await page.getByText(highAnswer, { exact: true }).hover();
      await capture("04-latest-attempt");

      await page.getByRole("button", { name: "Previous attempt", exact: true }).click();
      await expect.element(page.getByText(initialAnswer, { exact: true })).toBeVisible();
      await expect.element(page.getByText(highAnswer, { exact: true })).not.toBeInTheDocument();
      await expect
        .element(page.getByTestId("retry-effort-variant-pager"))
        .toHaveTextContent("1 / 2");
      await capture("05-previous-attempt");

      await page.getByRole("button", { name: "Next attempt", exact: true }).click();
      await expect.element(page.getByText(highAnswer, { exact: true })).toBeVisible();
      await expect
        .element(page.getByTestId("retry-effort-variant-pager"))
        .toHaveTextContent("2 / 2");
      await capture("06-returned-latest");
      expect(hasDispatchedCommandType("thread.meta.update")).toBe(false);
      expect(observedPhases).toEqual([
        "00-initial",
        "01-answer-actions",
        "02-effort-menu",
        "03-confirmation",
        "04-latest-attempt",
        "05-previous-attempt",
        "06-returned-latest",
      ]);
    } finally {
      const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]');
      const cancel = Array.from(dialog?.querySelectorAll<HTMLButtonElement>("button") ?? []).find(
        (button) => button.textContent?.trim() === "Cancel",
      );
      cancel?.click();
      await mounted.cleanup();
      restoreNativeApi();
    }
  });
});

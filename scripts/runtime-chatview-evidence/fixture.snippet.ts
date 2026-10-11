it.each(["keyboard", "wheel"] as const)(
  "PR UI evidence: preserve a ChatView reading position through streaming after %s input",
  async (gesture) => {
    const variant = import.meta.env.VITE_PR_CHATVIEW_VARIANT;
    const directory = import.meta.env.VITE_PR_CHATVIEW_OUTPUT;
    expect(["before", "after"]).toContain(variant);
    expect(directory).toMatch(/^\//);
    let snapshot = createSnapshotWithLongAssistantResponse();
    snapshot = {
      ...snapshot,
      projects: snapshot.projects.map((project) => ({ ...project, title: "Release review" })),
      threads: snapshot.threads.map((thread) =>
        thread.id === THREAD_ID
          ? { ...thread, title: "Review the release checklist" }
          : thread,
      ),
    };
    const mounted = await mountChatView({
      viewport: { ...DEFAULT_VIEWPORT, width: 1280, height: 900 },
      snapshot,
    });
    const messageId = MessageId.makeUnsafe("evidence-streaming-checklist");
    const turnId = TurnId.makeUnsafe("evidence-streaming-turn");
    let paragraphCount = 0;
    const paragraph = (index: number) =>
      "Step " + index + ". Review the changes and their verification results. " +
      "Keep the current reading position while additional checklist items arrive below. " +
      "The transcript should let you examine the earlier reasoning, compare the evidence, " +
      "and return to the newest output only when you choose to continue following.";
    const syncThread = (
      update: (
        thread: OrchestrationReadModel["threads"][number],
      ) => OrchestrationReadModel["threads"][number],
    ) => {
      snapshot = {
        ...snapshot,
        snapshotSequence: snapshot.snapshotSequence + 1,
        threads: snapshot.threads.map((thread) =>
          thread.id === THREAD_ID ? update(thread) : thread,
        ),
      };
      fixture = { ...fixture, snapshot };
      useStore.getState().syncServerReadModel(snapshot);
    };
    const grow = () => {
      paragraphCount += 1;
      syncThread((thread) => ({
        ...thread,
        messages: thread.messages.map((message) =>
          message.id === messageId
            ? {
                ...message,
                text: message.text + "\n\n" + paragraph(paragraphCount),
                updatedAt: isoAt(1_300 + paragraphCount),
              }
            : message,
        ),
      }));
    };
    const states: Array<Record<string, unknown>> = [];
    try {
      const container = await waitForElement(
        () => document.querySelector<HTMLElement>("[data-chat-scroll-container='true']"),
        "The actual ChatView transcript did not mount.",
      );
      await document.fonts.ready;
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      syncThread((thread) => ({
        ...thread,
        session: thread.session
          ? { ...thread.session, status: "running", activeTurnId: turnId }
          : null,
        latestTurn: {
          turnId,
          state: "running",
          requestedAt: isoAt(1_200),
          startedAt: isoAt(1_201),
          completedAt: null,
          assistantMessageId: messageId,
        },
        messages: [
          ...thread.messages,
          {
            id: messageId,
            role: "assistant",
            source: "native",
            text: "I am reviewing the release checklist and its supporting evidence.",
            turnId,
            streaming: true,
            createdAt: isoAt(1_202),
            updatedAt: isoAt(1_202),
          },
        ],
      }));
      const waitForPaintedOutput = async () => {
        await vi.waitFor(
          () => {
            const paragraphs = container
              .querySelector("[data-message-id='" + messageId + "']")
              ?.querySelectorAll("p");
            expect(paragraphs?.length).toBe(paragraphCount + 1);
            expect(paragraphs?.[paragraphCount]?.textContent).toBe(paragraph(paragraphCount));
          },
          { timeout: 10_000, interval: 20 },
        );
        await waitForTranscriptLayoutToSettle(container);
      };
      const capture = async (name: string, extra: Record<string, unknown> = {}) => {
        states.push({
          name,
          scrollTop: container.scrollTop,
          scrollHeight: container.scrollHeight,
          clientHeight: container.clientHeight,
          distanceFromBottom: getScrollContainerDistanceFromBottom(container),
          paragraphs: paragraphCount + 1,
          ...extra,
        });
        await page.screenshot({ path: directory + "/" + gesture + "-" + name + ".png" });
        await new Promise<void>((resolve) => setTimeout(resolve, 400));
      };
      for (let index = 0; index < 12; index += 1) {
        grow();
        await waitForLayout();
      }
      await waitForPaintedOutput();
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
      expect(container.scrollHeight).toBeGreaterThan(container.clientHeight * 2);
      await capture("following");

      let inputStartTop = container.scrollTop;
      if (gesture === "keyboard") {
        // As in the canonical keyboard regression, make the real transcript
        // focusable; no dimensions, scroll methods, events or hooks are replaced.
        container.tabIndex = 0;
        container.focus();
        expect(document.activeElement).toBe(container);
        let keyTarget: EventTarget | null = null;
        const recordKey = (event: KeyboardEvent) => {
          if (event.key === "PageUp") {
            inputStartTop = container.scrollTop;
            keyTarget = event.target;
          }
        };
        container.addEventListener("keydown", recordKey, { capture: true });
        try {
          await userEvent.keyboard("{PageUp}");
        } finally {
          container.removeEventListener("keydown", recordKey, { capture: true });
        }
        expect(keyTarget).toBe(container);
      } else {
        await userEvent.wheel(container, { delta: { y: -350 } });
      }
      await vi.waitFor(() => expect(container.scrollTop).toBeLessThan(inputStartTop - 100));
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeGreaterThan(100),
      );
      await waitForTranscriptLayoutToSettle(container);
      const viewport = container.getBoundingClientRect();
      const anchor = Array.from(
        container.querySelectorAll<HTMLElement>("[data-message-id] p, [data-message-id] li"),
      ).find((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
      expect(anchor, "A real visible paragraph must identify the reader position").toBeDefined();
      const anchorMessage = anchor!.closest<HTMLElement>("[data-message-id]")!;
      const anchorIndex = Array.from(anchorMessage.querySelectorAll("p, li")).indexOf(anchor!);
      const selector = "[data-message-id='" + CSS.escape(anchorMessage.dataset.messageId!) + "']";
      const anchorTop = () =>
        container.querySelector(selector)!.querySelectorAll("p, li")[anchorIndex]!
          .getBoundingClientRect().top;
      const detachedTop = anchorTop();
      const anchorText = anchor!.textContent;
      await capture("reading", { anchorTop: detachedTop, anchorText, inputStartTop });
      for (let index = 0; index < 3; index += 1) {
        grow();
        await waitForLayout();
      }
      await waitForPaintedOutput();
      await vi.waitFor(() => expect(anchorTop()).toBeCloseTo(detachedTop, 0), {
        timeout: 3_000,
        interval: 16,
      });
      expect(getScrollContainerDistanceFromBottom(container)).toBeGreaterThan(100);
      await capture("streaming-while-reading", {
        anchorTop: anchorTop(),
        anchorText,
        anchorDrift: anchorTop() - detachedTop,
      });

      const arrow = await waitForElement(
        () => document.querySelector<HTMLButtonElement>(
          "button[aria-label='Scroll to bottom'][aria-hidden='false']",
        ),
        "The actual return-to-bottom control did not appear.",
      );
      await userEvent.click(arrow);
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      for (let index = 0; index < 2; index += 1) {
        grow();
        await waitForLayout();
      }
      await waitForPaintedOutput();
      await vi.waitFor(() =>
        expect(getScrollContainerDistanceFromBottom(container)).toBeLessThanOrEqual(4),
      );
      await capture("following-resumed");
      console.log("PR_CHATVIEW_SCROLL_RESULT " + JSON.stringify({
        variant,
        gesture,
        input: gesture === "keyboard" ? "Chromium PageUp" : "Chromium wheel deltaY=-350",
        states,
        boundary: "Actual ChatView, production CSS, router and virtual list with fixture orchestration. No forced geometry or compensation race; the separate unchanged ten-test control demonstrates that race.",
      }));
    } catch (error) {
      try {
        await page.screenshot({ path: directory + "/" + gesture + "-failure.png" });
      } catch (captureError) {
        console.warn("Unable to retain failure screenshot", captureError);
      }
      throw error;
    } finally {
      await mounted.cleanup();
    }
  },
);


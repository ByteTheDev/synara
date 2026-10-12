
  describe("PR1866 projection evidence", () => {
    it("renders the real SQLite live-owner result before and after reconciliation", async () => {
      const envelope = ReconciliationSchema.decodeUnknownSync(ReconciliationSchema.Struct({
        schemaVersion: ReconciliationSchema.Literal(1),
        side: ReconciliationSchema.Literals(["before", "after"]),
        source: ReconciliationSchema.String,
        driver: ReconciliationSchema.String,
        threadId: ReconciliationSchema.String,
        reconciliationObservationOffsetMs: ReconciliationSchema.Number,
        realAdapterAndWatchdogClock: ReconciliationSchema.Boolean,
        actualNativeTurnIdBefore: ReconciliationSchema.String,
        actualNativeTurnIdAfter: ReconciliationSchema.String,
        observations: ReconciliationSchema.Array(ReconciliationSchema.Struct({
          stage: ReconciliationSchema.Literals(["live", "reconciled"]),
          capturedAt: ReconciliationSchema.String,
          snapshot: ReconciliationReadModelSchema,
        })),
      }))(reconciliationPayload);
      const side = import.meta.env.VITE_PR1866_SIDE;
      const source = import.meta.env.VITE_PR1866_SOURCE;
      const output = import.meta.env.VITE_PR1866_OUTPUT;
      expect(envelope.side).toBe(side);
      expect(envelope.source).toBe(source);
      expect(envelope.reconciliationObservationOffsetMs).toBe(46 * 60_000);
      expect(envelope.realAdapterAndWatchdogClock).toBe(true);
      expect(envelope.actualNativeTurnIdBefore).toBe("fixture-turn-1");
      expect(envelope.actualNativeTurnIdAfter).toBe("fixture-turn-1");
      expect(envelope.observations.map((row) => row.stage)).toEqual(["live", "reconciled"]);
      if (typeof output !== "string" || !output.startsWith("/")) {
        throw new Error("Explicit in-workspace browser evidence output is required");
      }
      const live = envelope.observations[0]!.snapshot;
      const reconciled = envelope.observations[1]!.snapshot;
      expect(live.threads).toHaveLength(1);
      expect(reconciled.threads).toHaveLength(1);
      const threadId = live.threads[0]!.id;
      expect(threadId).toBe(envelope.threadId);
      expect(live.threads[0]!.session?.activeTurnId).toBe("fixture-turn-1");
      expect(live.threads[0]!.latestTurn?.state).toBe("running");
      expect(reconciled.threads[0]!.session?.status).toBe(
        side === "before" ? "interrupted" : "running",
      );
      expect(reconciled.threads[0]!.latestTurn?.completedAt === null).toBe(side === "after");
      const project = live.projects.find((row) => row.id === live.threads[0]!.projectId)!;
      expect(project).toBeDefined();
      const mounted = await mountChatView({
        viewport: { name: "reconciliation", width: 960, height: 1100 },
        snapshot: live,
        initialEntry: "/" + threadId,
        configureFixture(nextFixture) {
          nextFixture.welcome = {
            ...nextFixture.welcome,
            cwd: project.workspaceRoot,
            projectName: project.title,
            bootstrapProjectId: project.id,
            bootstrapThreadId: threadId,
          };
        },
      });
      const phases: string[] = [];
      const liveHeader = () =>
        document.querySelector<HTMLElement>('[data-turn-header="live"]');
      async function capture(
        stage: "live" | "reconciled",
        snapshot: OrchestrationReadModel,
      ) {
        await document.fonts.ready;
        await waitForLayout();
        expect(window.innerWidth).toBe(960);
        expect(window.innerHeight).toBe(1100);
        expect(document.querySelector('[data-chat-composer-form="true"]')).not.toBeNull();
        const current = snapshot.threads[0]!;
        const assistant = current.messages.find((message) =>
          message.text.includes("Working on fixture-turn-1"),
        );
        expect(assistant).toBeDefined();
        await expect.element(page.getByText(assistant!.text, { exact: true })).toBeVisible();
        const running = stage === "live" || side === "after";
        await vi.waitFor(() => {
          if (running) expect(liveHeader()?.textContent).toMatch(/^Working for \d/);
          else expect(liveHeader()).toBeNull();
        }, { timeout: 10_000, interval: 16 });
        const filename = stage === "live" ? "00-live.png" : "01-reconciled.png";
        await page.screenshot({ path: output + "/" + filename });
        phases.push(stage);
        console.log("PR1866_UI_OBSERVATION " + JSON.stringify({
          side, source, driver: envelope.driver, stage,
          projectedSequence: snapshot.snapshotSequence,
          projectedSessionStatus: current.session?.status ?? null,
          projectedTurnState: current.latestTurn?.state ?? null,
          projectedActiveTurnId: current.session?.activeTurnId ?? null,
          projectedCompletedAt: current.latestTurn?.completedAt ?? null,
          actualNativeTurnId: envelope.actualNativeTurnIdAfter,
          liveHeaderText: liveHeader()?.textContent ?? null,
          visibleText: document.body.innerText.slice(0, 16000),
          viewport: { width: window.innerWidth, height: window.innerHeight },
          mountedRoute: mounted.router.state.location.pathname,
          backendBoundary:
            "Unmodified actual server projections delivered through the canonical controlled browser RPC fixture. No fabricated turn state, native Electron interaction, live model or 46-minute wall-clock duration.",
        }));
      }
      try {
        await capture("live", live);
        // Feed the second exact exported server projection to the existing
        // read-model boundary. Preserve every timestamp, sequence and message.
        fixture = { ...fixture, snapshot: reconciled };
        useStore.getState().syncServerReadModel(reconciled);
        await capture("reconciled", reconciled);
        expect(phases).toEqual(["live", "reconciled"]);
      } finally {
        await mounted.cleanup();
      }
    });
  });

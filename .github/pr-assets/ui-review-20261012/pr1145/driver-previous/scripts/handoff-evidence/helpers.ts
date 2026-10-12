async function observeDurableHandoff(
  stage: "pending" | "settled",
  outcome: "completed" | "failed",
  mounted: Pick<MountedChatView, "setViewport">,
  editor: HTMLElement,
  draft: string,
): Promise<void> {
  const directory = import.meta.env.VITE_HANDOFF_EVIDENCE_OUTPUT;
  const variant = import.meta.env.VITE_HANDOFF_EVIDENCE_VARIANT;
  const source = import.meta.env.VITE_HANDOFF_EVIDENCE_SOURCE;
  if (
    typeof directory !== "string" ||
    !directory.startsWith("/") ||
    !["before", "after"].includes(variant) ||
    !/^[a-f0-9]{40}$/.test(source)
  )
    throw new Error("An exact handoff evidence target is required.");
  const prior = { name: "restore", width: window.innerWidth, height: window.innerHeight };
  const views = [
    { name: "desktop", width: 960, height: 1100 },
    { name: "narrow", width: 480, height: 640 },
  ] as const;
  try {
    for (const viewport of views) {
      await mounted.setViewport(viewport);
      await vi.waitFor(() => expect(document.fonts.status).toBe("loaded"), { timeout: 3_000 });
      await waitForLayout();
      await vi.waitFor(
        () => {
          const running = document
            .getAnimations()
            .filter(
              (animation) =>
                Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
                (animation.pending || animation.playState === "running"),
            );
          expect(running).toHaveLength(0);
        },
        { timeout: 3_000 },
      );
      expect(editor.isConnected).toBe(true);
      expect(editor.textContent).toContain(draft);
      const submitButtons = editor.closest("form")?.querySelectorAll('button[type="submit"]');
      expect(submitButtons).toHaveLength(1);
      const send = submitButtons?.item(0);
      if (!(send instanceof HTMLButtonElement))
        throw new Error("The actual composer form must have one submit button.");
      const geometry = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      const phase = outcome + "-" + stage + "-" + viewport.name;
      const observation = {
        phase,
        stage,
        outcome,
        source,
        variant,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        time: new Date().toISOString(),
        fonts: document.fonts.status,
        theme: document.documentElement.getAttribute("data-theme-variant"),
        backgroundToken: getComputedStyle(document.documentElement)
          .getPropertyValue("--background")
          .trim(),
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        documentWidth: document.documentElement.scrollWidth,
        editor: {
          editable: editor.contentEditable,
          text: editor.textContent,
          box: geometry(editor),
        },
        send: {
          disabled: send.disabled,
          label: send.getAttribute("aria-label"),
          box: geometry(send),
        },
        statuses: [...document.querySelectorAll('[role="status"]')].map((element) => ({
          text: element.textContent,
          visible: element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
          box: geometry(element),
        })),
        transcript: [...document.querySelectorAll("[data-message-role]")].map((element) => ({
          role: element.getAttribute("data-message-role"),
          text: element.textContent,
        })),
        fixtureThreadId: fixture.snapshot.threads[0]?.id,
        fixtureModel: fixture.snapshot.threads[0]?.modelSelection,
      };
      await page.screenshot({ path: directory + "/" + phase + ".png" });
      console.log("HANDOFF_EVIDENCE_OBSERVATION " + JSON.stringify(observation));
    }
  } finally {
    await mounted.setViewport(prior);
  }
}

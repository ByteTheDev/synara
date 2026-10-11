  it.each(["view", "generation"] as const)("source UI evidence renders %s projection", async (kind) => {
    const entry = rootProjectionEvidence.cases.find((entry) => entry.kind === kind);
    if (!entry) throw new Error("Missing source-produced projection.");
    const snapshot = entry.snapshot as unknown as OrchestrationReadModel;
    expect(snapshot.threads).toHaveLength(1);
    expect(snapshot.threads[0]?.messages).toEqual(entry.projectedThread.messages);
    expect(snapshot.threads[0]?.activities).toEqual(entry.projectedThread.activities);
    const projectedThread = snapshot.threads[0];
    if (!projectedThread) throw new Error("Missing projected thread.");
    const imageRequests: string[] = [];
    const imageBytes = Uint8Array.from(atob(entry.imageBase64), (c) => c.charCodeAt(0));
    worker.use(http.get("*/api/local-image", ({ request }) => {
      const requested = new URL(request.url).searchParams.get("path");
      imageRequests.push(requested ?? "");
      return requested === entry.imagePath
        ? new HttpResponse(imageBytes.slice(), { headers: { "Content-Type": "image/png" } })
        : new HttpResponse(null, { status: 404 });
    }));
    const mounted = await mountChatView({
      viewport: { name: "source-evidence", width: 960, height: 1100 },
      snapshot,
      initialEntry: "/thread-1",
      configureFixture: (current) => {
        current.welcome = {
          ...current.welcome,
          bootstrapThreadId: projectedThread.id,
          bootstrapProjectId: projectedThread.projectId,
        };
      },
    });
    try {
      await expect.element(page.getByText(entry.text, { exact: false }).first()).toBeVisible();
      const actualHasImage = entry.projectedThread.messages.some((message) => message.text.includes("![Generated image]"));
      if (actualHasImage) {
        await expect.poll(() => {
          const image = document.querySelector<HTMLImageElement>('img[alt="Generated image"]');
          return Boolean(image?.complete && image.naturalWidth > 0);
        }).toBe(true);
        expect(imageRequests).toContain(entry.imagePath);
      }
      await document.fonts.ready;
      await waitForLayout();
      const images = [...document.querySelectorAll<HTMLImageElement>('img[alt="Generated image"]')];
      const stage = kind === "view" ? "view-result" : "generation-control";
      const directory = import.meta.env.VITE_PR_ROOT_OUTPUT;
      if (!directory?.startsWith("/")) throw new Error("Missing owned image destination.");
      await page.screenshot({ path: directory + "/" + stage + ".png" });
      console.log("PR_ROOT_OBSERVATION " + JSON.stringify({
        stage, source: entry.source, sourceTree: entry.sourceTree,
        projectionSha256: entry.projectionSha256, kind,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        rawMessageTexts: entry.projectedThread.messages.map((m) => m.text),
        imageCount: images.length,
        imageRequests,
        images: images.map((image) => ({ src: image.getAttribute("src"), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight })),
        qualification: "Full production ChatView renders actual source-produced SQLite messages through canonical controlled RPC fixtures; exact checked-in image bytes use a labelled local-image HTTP seam.",
      }));
      expect(images).toHaveLength(kind === "generation" ? 1 : 0);
    } finally {
      await mounted.cleanup();
      worker.resetHandlers();
    }
  });


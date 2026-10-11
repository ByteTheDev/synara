  it.each(["view", "generation"] as const)("source UI evidence exports %s projection", async (kind) => {
    const { resolveCodexGeneratedImagesRoot } = await import("../../codexGeneratedImages.ts");
    const output = process.env.PR_ROOT_OUTPUT;
    const applicationRoot = process.env.PR_ROOT_APPLICATION_ROOT;
    if (!output || !path.isAbsolute(output) || !applicationRoot || !path.isAbsolute(applicationRoot)) {
      throw new Error("Explicit owned evidence paths are required.");
    }
    const home = makeTempDir("synara-image-evidence-");
    vi.stubEnv("SYNARA_HOME", home);
    try {
      const harness = await createHarness({ startIngestion: false });
      const sourceRoot = resolveCodexGeneratedImagesRoot();
      fs.mkdirSync(sourceRoot, { recursive: true });
      const imagePath = path.join(sourceRoot, "inspection 100%.png");
      const imageBytes = fs.readFileSync(path.join(applicationRoot, "assets/beta/beta-web-apple-touch-180.png"));
      fs.writeFileSync(imagePath, imageBytes, { flag: "wx" });
      const threadId = asThreadId("thread-1");
      const turnId = asTurnId("source-image-evidence");
      const createdAt = "2026-10-11T12:00:00.000Z";
      const text = kind === "view"
        ? "Inspection complete. The input image contains the Synara Beta mark."
        : "Generated image ready.";
      const events: ProviderRuntimeEvent[] = [
        {
          type: "turn.started", eventId: asEventId("evidence-start"), provider: "codex",
          threadId, turnId, createdAt, payload: {},
        },
        {
          type: "content.delta", eventId: asEventId("evidence-answer-delta"), provider: "codex",
          threadId, turnId, createdAt, itemId: asItemId("evidence-answer"),
          payload: { streamKind: "assistant_text", delta: text },
        },
        {
          type: "item.completed", eventId: asEventId("evidence-answer-complete"), provider: "codex",
          threadId, turnId, createdAt, itemId: asItemId("evidence-answer"),
          payload: { itemType: "assistant_message", status: "completed" },
        },
        {
          type: "item.completed", eventId: asEventId("evidence-image"), provider: "codex",
          threadId, turnId, createdAt, itemId: asItemId("evidence-image"),
          payload: {
            itemType: "image_generation", status: "completed", title: "Image", detail: imagePath,
            data: { kind: "codex.generated_image", path: imagePath, callId: "evidence-image" },
          },
          raw: {
            source: "codex.app-server.notification",
            method: kind === "generation" ? "image_generation_end" : "item/completed",
            payload: kind === "generation" ? {} : { item: { type: "imageView", path: imagePath } },
          },
        },
        {
          type: "turn.completed", eventId: asEventId("evidence-end"), provider: "codex",
          threadId, turnId, createdAt, payload: { state: "completed" },
        },
      ];
      for (const event of events) await Effect.runPromise(harness.runtimeEventRepository.append(event));
      await harness.startIngestion();
      await harness.drain();
      await waitForThread(harness.engine, (thread) => thread.activities.some((a) => a.id === "evidence-end"));
      const projectedThread = await harness.readProjectedThread();
      if (!projectedThread) throw new Error("The real SQLite thread projection is missing.");
      const commandReadModel = await Effect.runPromise(harness.engine.getReadModel());
      // The transport fixture uses the actual database thread detail with the
      // actual project/space shell. Message/activity values are never rewritten.
      const snapshot = { ...commandReadModel, threads: [projectedThread] };
      fs.writeFileSync(path.join(output, "projection-" + kind + ".json"), JSON.stringify({
        kind, source: process.env.PR_ROOT_SOURCE, sourceTree: process.env.PR_ROOT_TREE,
        inputEvents: events, commandReadModel, projectedThread, snapshot,
        imagePath, imageBase64: imageBytes.toString("base64"), text,
        qualification: "Actual SQLite journal ingestion and thread detail; controlled provider events and checked-in PNG, no live Codex session or generated artwork claim.",
      }, null, 2) + "\n", { flag: "wx" });
      const answer = projectedThread.messages.find((message) => message.id === "assistant:evidence-answer");
      expect(answer?.text).toContain(text);
      expect(answer?.streaming).toBe(false);
      // Same correctness assertion on both heads. Before must retain its real
      // misclassified-view failure after exporting the observed database bytes.
      expect(projectedThread.messages.some((message) => message.text.includes("![Generated image]"))).toBe(kind === "generation");
    } finally {
      vi.unstubAllEnvs();
    }
  });


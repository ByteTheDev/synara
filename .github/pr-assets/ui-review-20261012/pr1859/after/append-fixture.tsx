// Source-pinned review observations. The canonical cases and their assertions
// are kept intact; these helpers only observe the rendered production tree.
function pr1859ReadWorkingLabels(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".shimmer-group"))
    .map((element) => element.textContent?.trim() ?? "")
    .filter((text) => /^(Loading|Thinking|Starting Devin…)$/.test(text));
}

async function pr1859Capture(phase: string): Promise<void> {
  const output = import.meta.env.VITE_PR1859_OUTPUT;
  const source = import.meta.env.VITE_PR1859_SOURCE;
  const side = import.meta.env.VITE_PR1859_SIDE;
  expect(typeof output).toBe("string");
  expect(typeof source).toBe("string");
  expect(["before", "after"]).toContain(side);
  await waitForLayout();
  const composer = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
  expect(composer).not.toBeNull();
  expect(composer!.getBoundingClientRect().height).toBeGreaterThan(0);
  const stops = wsRequests
    .filter((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand)
    .map((request) => request.command as { type?: string; threadId?: string; taskId?: string })
    .filter((command) => command?.type === "thread.task.stop")
    .map((command) => ({ type: command.type, threadId: command.threadId, taskId: command.taskId }));
  const thread = fixture.snapshot.threads.find((entry) => entry.id === THREAD_ID);
  const observation = {
    phase,
    side,
    source,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    workingLabels: pr1859ReadWorkingLabels(),
    provider: thread?.modelSelection.provider ?? null,
    sessionStatus: thread?.session?.status ?? null,
    latestTurnState: thread?.latestTurn?.state ?? null,
    backgroundTask:
      document.querySelector<HTMLElement>("[data-background-task='pr1859-check-task']")
        ?.textContent ?? null,
    stops,
    fixtureBoundary:
      "Controlled read-model and RPC replies; actual production ChatView, task row, CSS and real pointer actions.",
  };
  await page.screenshot({ path: `${output}/${phase}.png` });
  console.log("PR1859_OBSERVATION " + JSON.stringify(observation));
}

function pr1859DevinSnapshot(active: boolean): OrchestrationReadModel {
  const snapshot = createSnapshotForTargetUser({
    targetMessageId: MessageId.makeUnsafe("pr1859-user"),
    targetText: "Inspect the fixture repository and report validation results.",
    sessionStatus: "starting",
  });
  const turnId = TurnId.makeUnsafe("pr1859-active-turn");
  return {
    ...snapshot,
    projects: snapshot.projects.map((project) => ({
      ...project,
      defaultModelSelection: { provider: "devin", model: DEFAULT_MODEL_BY_PROVIDER.devin },
    })),
    threads: snapshot.threads.map((thread) => ({
      ...thread,
      title: "Devin background validation",
      modelSelection: { provider: "devin", model: DEFAULT_MODEL_BY_PROVIDER.devin },
      messages: [
        {
          ...createUserMessage({
            id: MessageId.makeUnsafe("pr1859-user"),
            text: "Inspect the fixture repository and report validation results.",
            offsetSeconds: 1,
          }),
          ...(active ? { turnId } : {}),
        },
      ],
      latestTurn: active
        ? {
            turnId,
            state: "running",
            requestedAt: isoAt(1),
            startedAt: isoAt(2),
            completedAt: null,
            assistantMessageId: null,
          }
        : null,
      activities: active
        ? [
            {
              id: EventId.makeUnsafe("pr1859-task-start"),
              createdAt: isoAt(3),
              kind: "task.started",
              summary: "Background validation started",
              tone: "info",
              turnId,
              payload: { taskId: "pr1859-check-task", taskType: "local_bash" },
            },
            {
              id: EventId.makeUnsafe("pr1859-background-notice"),
              createdAt: isoAt(4),
              kind: "runtime.warning",
              summary: "Background tasks changed",
              tone: "info",
              turnId,
              payload: {
                nativeEventType: "background_tasks_changed",
                data: {
                  tasks: [
                    {
                      task_id: "pr1859-check-task",
                      task_type: "local_bash",
                      description: "Validate the fixture repository",
                    },
                  ],
                },
              },
            },
          ]
        : [],
      session: thread.session
        ? {
            ...thread.session,
            providerName: "devin",
            status: "starting",
            activeTurnId: active ? turnId : null,
          }
        : null,
    })),
  };
}

function pr1859ConfigureDevin(next: TestFixture): void {
  next.serverConfig = {
    ...next.serverConfig,
    providers: [
      {
        provider: "devin",
        instanceId: "devin",
        driver: "devin",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
    ],
  };
}

it("PR1859 review evidence preserves startup before provider activity", async () => {
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot: pr1859DevinSnapshot(false),
    configureFixture: pr1859ConfigureDevin,
  });
  try {
    await expect.element(page.getByText("Starting Devin…", { exact: true })).toBeVisible();
    expect(pr1859ReadWorkingLabels()).toEqual(["Starting Devin…"]);
    await pr1859Capture("devin-starting");
  } finally {
    await mounted.cleanup();
  }
});

it("PR1859 review evidence reports active Devin work and sends the exact task stop", async () => {
  const mounted = await mountChatView({
    viewport: DEFAULT_VIEWPORT,
    snapshot: pr1859DevinSnapshot(true),
    configureFixture: pr1859ConfigureDevin,
  });
  try {
    const stop = page.getByRole("button", {
      name: "Stop background task Validate the fixture repository",
      exact: true,
    });
    await expect.element(stop).toBeVisible();
    await vi.waitFor(() => expect(pr1859ReadWorkingLabels().length).toBe(1));
    // Capture both sources before the same strict repaired-label assertion.
    // The Before test retains its actual failure and original startup pixels.
    await pr1859Capture("devin-active");
    await stop.click();
    await vi.waitFor(() => {
      const commands = wsRequests
        .filter((request) => request._tag === ORCHESTRATION_WS_METHODS.dispatchCommand)
        .map((request) => request.command as { type?: string; threadId?: string; taskId?: string })
        .filter((command) => command?.type === "thread.task.stop");
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        type: "thread.task.stop",
        threadId: THREAD_ID,
        taskId: "pr1859-check-task",
      });
    });
    await pr1859Capture("devin-stop-request");
    await expect.element(page.getByText("Thinking", { exact: true })).toBeVisible();
    expect(pr1859ReadWorkingLabels()).toEqual(["Thinking"]);
    expect(document.body.textContent).not.toContain("Starting Devin…");
  } finally {
    await mounted.cleanup();
  }
});

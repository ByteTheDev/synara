import { ProjectId, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { afterEach, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useComposerDraftStore } from "../composerDraftStore";
import { resetComposerDraftStore } from "../composerDraftStoreTestFixtures";
import { serverQueryKeys } from "../lib/serverReactQuery";
import { runComposerSendOnce } from "../lib/composerSendOwnership";
import { useOpenThreadTabsStore } from "../openThreadTabsStore";
import { useStore } from "../store";
import { initialState } from "../storeState";
import type { SidebarThreadSummary } from "../types";
import {
  createBrowserTestServerConfig,
  createBrowserTestServerSettings,
} from "../test/browserHarness";
import { useOpenThreadTabs } from "./useOpenThreadTabs";

function createQueryClient() {
  const queryClient = new QueryClient();
  const at = "2026-09-30T00:00:00.000Z";
  queryClient.setQueryData(serverQueryKeys.config(), createBrowserTestServerConfig(at));
  queryClient.setQueryData(serverQueryKeys.settings(), createBrowserTestServerSettings(at));
  return queryClient;
}

const makeTabSummary = (id: ThreadId, projectId: ProjectId): SidebarThreadSummary => ({
  id,
  projectId,
  title: id,
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: "2026-10-12T00:00:00.000Z",
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  hasLiveTailWork: false,
  pendingBackgroundWorkCount: 0,
  session: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
});

afterEach(() => {
  resetComposerDraftStore();
  useOpenThreadTabsStore.setState({ threadIds: [] });
  useStore.setState(initialState);
  localStorage.clear();
});

it("keeps each project's tabs when navigating between saved chats and drafts", async () => {
  const first = ThreadId.makeUnsafe("first");
  const second = ThreadId.makeUnsafe("second");
  const draft = ThreadId.makeUnsafe("draft");
  const projectA = ProjectId.makeUnsafe("a");
  const projectB = ProjectId.makeUnsafe("b");

  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: {
      [first]: makeTabSummary(first, projectA),
      [second]: makeTabSummary(second, projectB),
    },
  });
  useOpenThreadTabsStore.setState({ threadIds: [first, second] });
  useComposerDraftStore.getState().setProjectDraftThreadId(projectA, draft, {});
  const hook = await renderHook(
    (props) => useOpenThreadTabs({ activeThreadId: props?.activeThreadId ?? first }),
    {
      initialProps: { activeThreadId: first },
    },
  );
  try {
    expect(hook.result.current.map((tab) => tab.threadId)).toEqual([first]);
    await hook.rerender({ activeThreadId: second });
    expect(hook.result.current.map((tab) => tab.threadId)).toEqual([second]);
    await hook.rerender({ activeThreadId: draft });
    expect(hook.result.current.map((tab) => tab.threadId)).toEqual([first]);
    expect(useOpenThreadTabsStore.getState().threadIds).toEqual([first, second]);
  } finally {
    await hook.unmount();
  }
});

it("retains a background draft through hydration and reveals its tab after promotion", async () => {
  localStorage.setItem("synara:server-settings-migrated:v1", "1");
  const projectId = ProjectId.makeUnsafe("project");
  const threadId = ThreadId.makeUnsafe("background-draft");
  const activeThreadId = ThreadId.makeUnsafe("saved-thread");
  const summary = {
    id: activeThreadId,
    projectId,
    title: "Saved thread",
    modelSelection: { provider: "codex", instanceId: "codex_work", model: "gpt-5.4" },
    session: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
  } as SidebarThreadSummary;
  useComposerDraftStore.getState().setProjectDraftThreadId(projectId, threadId, {});
  useOpenThreadTabsStore.setState({ threadIds: [activeThreadId, threadId] });
  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: { [activeThreadId]: summary },
  });
  const queryClient = createQueryClient();
  const hook = await renderHook(() => useOpenThreadTabs({ activeThreadId }), {
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  try {
    expect(hook.result.current.map((tab) => tab.threadId)).toEqual([activeThreadId]);
    expect(useOpenThreadTabsStore.getState().threadIds).toContain(threadId);
    useComposerDraftStore.getState().clearDraftThread(threadId);
    useStore.setState({
      sidebarThreadSummaryById: {
        [activeThreadId]: summary,
        [threadId]: { ...summary, id: threadId, title: "First message" },
      },
    });
    await expect
      .poll(() => hook.result.current)
      .toEqual([
        expect.objectContaining({ threadId: activeThreadId, provider: "codex" }),
        expect.objectContaining({ threadId, title: "First message", provider: "codex" }),
      ]);
  } finally {
    await hook.unmount();
    queryClient.clear();
  }
});

it("starts and stops the worktree tab spinner with its send before a session exists", async () => {
  localStorage.setItem("synara:server-settings-migrated:v1", "1");
  const threadId = ThreadId.makeUnsafe("preparing-worktree-tab");
  useStore.setState({
    sidebarThreadSummaryById: {
      [threadId]: {
        id: threadId,
        projectId: ProjectId.makeUnsafe("project"),
        title: "Prepare worktree",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        envMode: "worktree",
        session: null,
        latestTurn: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      } as SidebarThreadSummary,
    },
  });
  useOpenThreadTabsStore.setState({ threadIds: [threadId] });
  const queryClient = createQueryClient();
  const hook = await renderHook(() => useOpenThreadTabs({ activeThreadId: threadId }), {
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });
  let finishSend!: (result: boolean) => void;
  const send = new Promise<boolean>((resolve) => {
    finishSend = resolve;
  });
  let operation: Promise<boolean> | undefined;
  try {
    expect(hook.result.current[0]?.isRunning).toBe(false);
    operation = runComposerSendOnce(threadId, () => send);
    await expect.poll(() => hook.result.current[0]?.isRunning).toBe(true);
    finishSend(true);
    await operation;
    await expect.poll(() => hook.result.current[0]?.isRunning).toBe(false);
  } finally {
    finishSend(false);
    await operation;
    await hook.unmount();
    queryClient.clear();
  }
});

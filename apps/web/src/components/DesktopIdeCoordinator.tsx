import { useEffect, useMemo, useState } from "react";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { useNavigate } from "@tanstack/react-router";
import { ThreadId, type DesktopIdeScope } from "@synara/contracts";
import { useFocusedChatContext } from "../focusedChatContext";
import { useDesktopIdeStore, toggleDesktopMode } from "../desktopIdeStore";
import { appendDesktopIdeContext } from "../lib/desktopIdeContext";
import { observeDesktopIdeAppearance } from "../lib/desktopIdeAppearance";
import { MessageCircleIcon, MonitorIcon, PlusIcon } from "../lib/icons";
import { useStore } from "../store";
import { createSidebarThreadSummariesSelector } from "../storeSelectors";
import { canSessionAnswerPendingRequests } from "../session-logic";
import { hasUnseenCompletion } from "./Sidebar.logic";
import { Button } from "./ui/button";
import { Select, SelectTrigger, SelectValue, SelectItem, SelectPopup } from "./ui/select";

function useDesktopSessions() {
  const selector = useMemo(createSidebarThreadSummariesSelector, []);
  const summaries = useStore(selector);
  return useMemo(() => summaries.filter((thread) => !thread.archivedAt), [summaries]);
}
function needsAttention(thread: ReturnType<typeof useDesktopSessions>[number]): boolean {
  return (
    hasUnseenCompletion(thread) ||
    (thread.session?.status === "error" &&
      (!thread.lastVisitedAt || thread.session.updatedAt > thread.lastVisitedAt)) ||
    Boolean(
      canSessionAnswerPendingRequests(thread.session) &&
      (thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.hasActionableProposedPlan),
    )
  );
}

/** One coordinator in the existing root; never mounts a second orchestration client. */
export function DesktopIdeCoordinator() {
  const { focusedThreadId, activeThread, activeDraftThread, activeProject, activeProjectId } =
    useFocusedChatContext();
  const status = useDesktopIdeStore((store) => store.state?.status);
  const receive = useDesktopIdeStore((store) => store.receive);
  const fail = useDesktopIdeStore((store) => store.fail);
  const sessions = useDesktopSessions();
  const navigate = useNavigate();
  const attention = useMemo(() => sessions.filter(needsAttention), [sessions]);
  const worktree = activeDraftThread?.worktreePath ?? activeThread?.worktreePath;
  const cwd =
    worktree ??
    activeDraftThread?.workingDirectory ??
    activeThread?.workingDirectory ??
    activeProject?.cwd;
  const scopeKey = JSON.stringify({
    threadId: focusedThreadId,
    projectId: activeProjectId,
    roots: cwd
      ? [cwd, ...(worktree ? [] : (activeProject?.additionalFolders ?? []))].slice(0, 16)
      : [],
  } satisfies DesktopIdeScope);

  useEffect(() => {
    const bridge = window.desktopBridge?.ide;
    if (!bridge) return;
    let disposed = false;
    const accept = (state: Parameters<typeof receive>[0]) => {
      if (disposed) return;
      receive(state);
      document.documentElement.dataset.synaraMode = state.mode;
    };
    const removeState = bridge.onState(accept);
    const removeContext = bridge.onContext((context) => {
      try {
        appendDesktopIdeContext(context);
      } catch (error) {
        fail(error);
      }
    });
    void bridge.getState().then(accept, fail);
    return () => {
      disposed = true;
      removeState();
      removeContext();
      delete document.documentElement.dataset.synaraMode;
    };
  }, [receive, fail]);
  useEffect(() => {
    const bridge = window.desktopBridge?.ide;
    if (status !== "ready" || !bridge?.setAppearance) return;
    return observeDesktopIdeAppearance((appearance) => bridge.setAppearance(appearance), fail);
  }, [status, fail]);
  useEffect(() => {
    if (status !== "ready") return;
    void window.desktopBridge?.ide?.setScope(JSON.parse(scopeKey) as DesktopIdeScope).catch(fail);
  }, [status, scopeKey, fail]);
  useEffect(() => {
    if (status !== "ready") return;
    void window.desktopBridge?.ide?.setAttention(attention.length).catch(fail);
  }, [status, attention.length, fail]);
  useEffect(
    () =>
      window.desktopBridge?.onMenuAction((action) => {
        if (action !== "ide-next-attention") return;
        const index = attention.findIndex((thread) => thread.id === focusedThreadId);
        const next = attention[(index + 1) % attention.length];
        if (next)
          void navigate({
            to: "/$threadId",
            params: { threadId: next.id },
            search: (previous) => ({ ...previous, splitViewId: undefined, view: undefined }),
          });
      }),
    [attention, focusedThreadId, navigate],
  );
  return null;
}

export function DesktopModeSwitch({ compact = false }: { compact?: boolean }) {
  const state = useDesktopIdeStore((store) => store.state);
  const error = useDesktopIdeStore((store) => store.error);
  if (!state || state.status === "unavailable") return null;
  return (
    <div className="synara-mode-switch no-drag" role="group" aria-label="Workspace mode">
      {(["agent", "ide"] as const).map((mode) => {
        const selected = state.mode === mode;
        const Icon = mode === "agent" ? MessageCircleIcon : MonitorIcon;
        const label = mode === "agent" ? "Agent" : "IDE";
        return (
          <Button
            key={mode}
            size="xs"
            variant="chrome"
            className="synara-mode-option"
            aria-label={`Switch to ${label} Mode`}
            aria-pressed={selected}
            disabled={state.status !== "ready"}
            title={error ?? state.message ?? `${label} Mode — keep sessions and editors running`}
            onClick={() => {
              if (!selected) void toggleDesktopMode();
            }}
          >
            <Icon className="size-3.5" aria-hidden="true" />
            {compact ? <span className="sr-only">{label}</span> : label}
          </Button>
        );
      })}
      {state.attention > 0 ? (
        <span
          className="synara-mode-attention text-ui-xs"
          aria-label={`${state.attention} sessions need attention`}
        >
          {state.attention}
        </span>
      ) : null}
    </div>
  );
}

export function DesktopIdeSessionBar() {
  const mode = useDesktopIdeStore((store) => store.state?.mode);
  const error = useDesktopIdeStore((store) => store.error);
  const sessions = useDesktopSessions();
  const { focusedThreadId, activeThread, activeProject } = useFocusedChatContext();
  const navigate = useNavigate();
  const { handleNewChat } = useHandleNewChat();
  const fail = useDesktopIdeStore((store) => store.fail);
  const [creating, setCreating] = useState(false);
  const createSession = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const result = await handleNewChat({ fresh: true });
      if (!result.ok) fail(result.error);
    } catch (error) {
      fail(error);
    } finally {
      setCreating(false);
    }
  };
  if (mode !== "ide") return null;
  return (
    <div className="synara-ide-session-bar no-drag shrink-0 text-ui-sm">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <DesktopModeSwitch />
        <Button
          size="icon-xs"
          variant="chrome"
          aria-label="New Synara session"
          title="New session"
          disabled={creating}
          aria-busy={creating}
          onClick={() => {
            void createSession();
          }}
        >
          <PlusIcon className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="flex min-w-0 items-center gap-1">
        <Select
          value={focusedThreadId ?? ""}
          onValueChange={(value) => {
            if (typeof value === "string" && value)
              void navigate({
                to: "/$threadId",
                params: { threadId: ThreadId.makeUnsafe(value) },
                search: (previous) => ({ ...previous, splitViewId: undefined, view: undefined }),
              });
          }}
        >
          <SelectTrigger
            size="sm"
            variant="ghost"
            className="min-w-0 flex-1 [&_[data-slot=select-value]]:truncate"
            aria-label="Active Synara agent session"
          >
            <SelectValue placeholder="Select an agent session">
              {activeThread?.title ||
                sessions.find((thread) => thread.id === focusedThreadId)?.title ||
                (focusedThreadId ? "New session" : "Select an agent session")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup surface="composer">
            {sessions.map((thread) => (
              <SelectItem key={thread.id} value={thread.id}>
                {needsAttention(thread) ? "● " : ""}
                {thread.title || "Untitled session"}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {activeProject ? (
        <p className="truncate px-2 text-ui-xs text-muted-foreground" title={activeProject.cwd}>
          {activeProject.name}
        </p>
      ) : null}
      {error ? (
        <p className="w-full text-ui-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

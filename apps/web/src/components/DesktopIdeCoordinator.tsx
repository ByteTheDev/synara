import { useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ThreadId, type DesktopIdeScope } from "@synara/contracts";
import { useFocusedChatContext } from "../focusedChatContext";
import { useDesktopIdeStore, toggleDesktopMode } from "../desktopIdeStore";
import { appendDesktopIdeContext } from "../lib/desktopIdeContext";
import { useStore } from "../store";
import { createSidebarThreadSummariesSelector } from "../storeSelectors";
import { canSessionAnswerPendingRequests } from "../session-logic";
import { hasUnseenCompletion } from "./Sidebar.logic";
import { Button } from "./ui/button";
import { Select, SelectTrigger, SelectValue, SelectItem, SelectPopup } from "./ui/select";

function useDesktopSessions() {
  const selector = useMemo(createSidebarThreadSummariesSelector, []);
  const summaries = useStore(selector);
  return useMemo(() => summaries.filter(thread => !thread.archivedAt), [summaries]);
}
function needsAttention(thread: ReturnType<typeof useDesktopSessions>[number]): boolean {
  return hasUnseenCompletion(thread) || Boolean(
    canSessionAnswerPendingRequests(thread.session) &&
    (thread.hasPendingApprovals || thread.hasPendingUserInput || thread.hasActionableProposedPlan)
  );
}

/** One coordinator in the existing root; never mounts a second orchestration client. */
export function DesktopIdeCoordinator() {
  const { focusedThreadId, activeThread, activeDraftThread, activeProject, activeProjectId } = useFocusedChatContext();
  const status = useDesktopIdeStore(store => store.state?.status);
  const receive = useDesktopIdeStore(store => store.receive);
  const fail = useDesktopIdeStore(store => store.fail);
  const sessions = useDesktopSessions();
  const navigate = useNavigate();
  const attention = useMemo(() => sessions.filter(needsAttention), [sessions]);
  const worktree = activeDraftThread?.worktreePath ?? activeThread?.worktreePath;
  const cwd = worktree ?? activeDraftThread?.workingDirectory ?? activeThread?.workingDirectory ?? activeProject?.cwd;
  const scopeKey = JSON.stringify({
    threadId: focusedThreadId, projectId: activeProjectId,
    roots: cwd ? [cwd, ...(worktree ? [] : (activeProject?.additionalFolders ?? []))].slice(0, 16) : [],
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
    const removeContext = bridge.onContext(context => {
      try { appendDesktopIdeContext(context); } catch (error) { fail(error); }
    });
    void bridge.getState().then(accept, fail);
    return () => { disposed = true; removeState(); removeContext(); delete document.documentElement.dataset.synaraMode; };
  }, [receive, fail]);
  useEffect(() => {
    if (status !== "ready") return;
    void window.desktopBridge?.ide?.setScope(JSON.parse(scopeKey) as DesktopIdeScope).catch(fail);
  }, [status, scopeKey, fail]);
  useEffect(() => {
    if (status !== "ready") return;
    void window.desktopBridge?.ide?.setAttention(attention.length).catch(fail);
  }, [status, attention.length, fail]);
  useEffect(() => window.desktopBridge?.onMenuAction(action => {
    if (action !== "ide-next-attention") return;
    const index = attention.findIndex(thread => thread.id === focusedThreadId);
    const next = attention[(index + 1) % attention.length];
    if (next) void navigate({ to: "/$threadId", params: { threadId: next.id }, search: previous => ({ ...previous, splitViewId: undefined, view: undefined }) });
  }), [attention, focusedThreadId, navigate]);
  return null;
}

export function DesktopModeSwitch({ compact = false }: { compact?: boolean }) {
  const state = useDesktopIdeStore(store => store.state);
  const error = useDesktopIdeStore(store => store.error);
  if (!state || state.status === "unavailable") return null;
  return <Button size="xs" variant="chrome" className="no-drag shrink-0" disabled={state.status !== "ready"}
    title={error ?? state.message ?? "Switch modes without stopping agents or closing editors. Configure the shortcut in IDE Keyboard Shortcuts."}
    aria-label={`Switch to ${state.mode === "agent" ? "IDE" : "Agent"} Mode`}
    onClick={() => { void toggleDesktopMode(); }}>
    {compact ? (state.mode === "agent" ? "IDE" : "Agent") : (state.mode === "agent" ? "Agent / IDE" : "IDE / Agent")}
    {state.attention > 0 ? <span aria-label={`${state.attention} sessions need attention`} className="rounded bg-accent px-1 text-ui-xs">{state.attention}</span> : null}
  </Button>;
}

export function DesktopIdeSessionBar() {
  const mode = useDesktopIdeStore(store => store.state?.mode);
  const error = useDesktopIdeStore(store => store.error);
  const sessions = useDesktopSessions();
  const { focusedThreadId } = useFocusedChatContext();
  const navigate = useNavigate();
  if (mode !== "ide") return null;
  return <div className="no-drag flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-background p-1 text-ui-xs">
    <DesktopModeSwitch compact />
    <Select value={focusedThreadId ?? ""} onValueChange={value => {
      if (typeof value === "string" && value) void navigate({ to: "/$threadId", params: { threadId: ThreadId.makeUnsafe(value) }, search: previous => ({ ...previous, splitViewId: undefined, view: undefined }) });
    }}>
      <SelectTrigger size="xs" className="min-w-0 flex-1" aria-label="Active Synara agent session"><SelectValue placeholder="Select an agent session" /></SelectTrigger>
      <SelectPopup>{sessions.map(thread => <SelectItem key={thread.id} value={thread.id}>
        {needsAttention(thread) ? "● " : ""}{thread.title || "Untitled session"}
      </SelectItem>)}</SelectPopup>
    </Select>
    {error ? <p className="w-full text-ui-xs text-destructive" role="alert">{error}</p> : null}
  </div>;
}

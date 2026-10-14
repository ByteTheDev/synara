import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DesktopIdeScope } from "@synara/contracts";
import { useFocusedChatContext } from "../focusedChatContext";
import { useDesktopIdeStore } from "../desktopIdeStore";
import { resolveKeybindingForCommand } from "../keybindings";
import { appendDesktopIdeContext } from "../lib/desktopIdeContext";
import { observeDesktopIdeAppearance } from "../lib/desktopIdeAppearance";
import { readLocalCodeOssBridge } from "../lib/desktopIdeBridge";
import { refreshGitAfterFileWrite } from "../lib/gitReactQuery";
import { serverConfigQueryOptions } from "../lib/serverReactQuery";
import { toastManager } from "./ui/toast";

/** Service coordination only: no view switch, session bar or second chat client. */
export function DesktopIdeCoordinator() {
  const { focusedThreadId, activeThread, activeDraftThread, activeProject, activeProjectId } = useFocusedChatContext();
  const client = useQueryClient();
  const status = useDesktopIdeStore((store) => store.state?.status);
  const editorRoots = useDesktopIdeStore((store) => store.editorRoots);
  const receive = useDesktopIdeStore((store) => store.receive);
  const receiveDebug = useDesktopIdeStore((store) => store.receiveDebug);
  const fail = useDesktopIdeStore((store) => store.fail);
  const config = useQuery(serverConfigQueryOptions());
  const saveBinding = resolveKeybindingForCommand(config.data?.keybindings ?? [], "editor.file.save");
  const saveShortcutKey = JSON.stringify(saveBinding?.shortcut ?? null);
  const worktree = activeDraftThread?.worktreePath ?? activeThread?.worktreePath;
  const cwd = worktree ?? activeDraftThread?.workingDirectory ?? activeThread?.workingDirectory ?? activeProject?.cwd;
  const scopeKey = JSON.stringify({
    threadId: focusedThreadId,
    projectId: activeProjectId,
    roots: [...new Set([
      ...editorRoots,
      ...(cwd ? [cwd, ...(worktree ? [] : activeProject?.additionalFolders ?? [])] : []),
    ])].slice(0, 16),
  } satisfies DesktopIdeScope);

  useEffect(() => {
    const bridge = readLocalCodeOssBridge();
    if (!bridge) return;
    let disposed = false;
    const accept = (state: Parameters<typeof receive>[0]) => { if (!disposed) receive(state); };
    const removeState = bridge.onState(accept);
    const removeContext = bridge.onContext((context) => {
      try { appendDesktopIdeContext(context); }
      catch (error) {
        fail(error);
        toastManager.add({ type: "error", title: "Could not add editor context", description: error instanceof Error ? error.message : String(error) });
      }
    });
    const removeEvent = bridge.onEvent((event) => {
      if (event.kind === "debug.state") receiveDebug(event.state);
      else if (event.kind === "git.changed") {
        void refreshGitAfterFileWrite(client, event.root).catch(fail);
        void client.invalidateQueries({ queryKey: ["projects", "read-file", event.root] }).catch(fail);
      }
    });
    void bridge.getState().then(accept, fail);
    return () => { disposed = true; removeState(); removeContext(); removeEvent(); };
  }, [receive, receiveDebug, fail, client]);

  useEffect(() => {
    const bridge = readLocalCodeOssBridge();
    if (status !== "ready" || !bridge) return;
    return observeDesktopIdeAppearance((appearance) => bridge.setAppearance(appearance), fail);
  }, [status, fail]);
  useEffect(() => {
    const bridge = readLocalCodeOssBridge();
    if (status !== "ready" || !bridge) return;
    void bridge.setScope(JSON.parse(scopeKey) as DesktopIdeScope).catch(fail);
  }, [status, scopeKey, fail]);
  useEffect(() => {
    const bridge = readLocalCodeOssBridge();
    if (status !== "ready" || !bridge) return;
    void bridge.setSaveShortcut(JSON.parse(saveShortcutKey)).catch(fail);
  }, [status, saveShortcutKey, fail]);
  return null;
}

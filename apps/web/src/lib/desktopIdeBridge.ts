import type { DesktopIdeBridge, DesktopIdeDocumentState, DesktopIdeReply } from "@synara/contracts";
import { isDesktopIdeDocumentState } from "@synara/contracts";
import { isLoopbackHostname } from "~/components/Sidebar.logic";
import { useDesktopIdeStore } from "~/desktopIdeStore";

/** Match Synara's existing local-permission boundary; an injected API may be remote. */
export function readLocalCodeOssBridge(): DesktopIdeBridge | null {
  if (typeof window === "undefined" || window.nativeApi) return null;
  const bridge = window.desktopBridge;
  if (!bridge?.ide) return null;
  try {
    const endpoint = bridge.getWsUrl?.();
    if (!endpoint) return null;
    const url = new URL(endpoint);
    return (url.protocol === "ws:" || url.protocol === "wss:") && isLoopbackHostname(url.hostname)
      ? bridge.ide
      : null;
  } catch { return null; }
}

export function readReadyCodeOssBridge(root: string): DesktopIdeBridge | null {
  const state = useDesktopIdeStore.getState().state;
  if (state?.status !== "ready" || !state.scope.roots.includes(root)) return null;
  return readLocalCodeOssBridge();
}

export function requireCodeOssDocument(reply: DesktopIdeReply): DesktopIdeDocumentState {
  if (!isDesktopIdeDocumentState(reply)) throw new Error("Code-OSS returned an invalid document state.");
  return reply;
}

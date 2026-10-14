import { create } from "zustand";
import type { DesktopIdeState } from "@synara/contracts";

// Ephemeral desktop presentation only. Provider/session state remains in Synara's
// existing stores and database; the workbench owns its own editor presentation.
export const useDesktopIdeStore = create<{
  state: DesktopIdeState | null;
  error: string | null;
  receive: (state: DesktopIdeState) => void;
  fail: (error: unknown) => void;
}>()((set) => ({
  state: null,
  error: null,
  receive: (state) => set({ state, error: null }),
  fail: (error) => set({ error: error instanceof Error ? error.message : String(error) }),
}));

export async function toggleDesktopMode(): Promise<void> {
  const { state, receive, fail } = useDesktopIdeStore.getState();
  if (!state || state.status !== "ready" || !window.desktopBridge?.ide) return;
  try {
    receive(await window.desktopBridge.ide.setMode(state.mode === "agent" ? "ide" : "agent"));
  } catch (error) {
    fail(error);
  }
}

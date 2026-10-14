import { create } from "zustand";
import type { DesktopIdeState } from "@synara/contracts";

/** Service availability only. Existing Synara stores continue to own navigation and sessions. */
export const useDesktopIdeStore = create<{
  state: DesktopIdeState | null;
  error: string | null;
  debugState: "inactive" | "initializing" | "running" | "stopped";
  receive: (state: DesktopIdeState) => void;
  fail: (error: unknown) => void;
  receiveDebug: (state: "inactive" | "initializing" | "running" | "stopped") => void;
}>()((set) => ({
  state: null,
  error: null,
  debugState: "inactive",
  receive: (state) => set({ state, error: null }),
  fail: (error) => set({ error: error instanceof Error ? error.message : String(error) }),
  receiveDebug: (debugState) => set({ debugState }),
}));

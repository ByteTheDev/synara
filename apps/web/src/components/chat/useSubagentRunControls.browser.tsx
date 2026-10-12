import { ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useSubagentRunControls } from "./useSubagentRunControls";

const state = vi.hoisted(() => ({
  provider: "devin",
  dispatch: vi.fn(async (_command: unknown) => {}),
}));
vi.mock("../../nativeApi", () => ({
  readNativeApi: () => ({ orchestration: { dispatchCommand: state.dispatch } }),
}));
vi.mock("../../store", () => ({ useStore: { getState: () => ({}) } }));
vi.mock("../../threadDerivation", () => ({
  getThreadFromState: () => ({
    session: { provider: state.provider, status: "ready" },
    latestTurn: null,
  }),
}));
vi.mock("../ChatView.selectors", () => ({
  localSubagentThreadId: (parent: string, child: string) => `subagent:${parent}:${child}`,
}));
function Controls() {
  const { stopSubagent } = useSubagentRunControls(ThreadId.makeUnsafe("parent"));
  return (
    <button onClick={() => void stopSubagent({ providerThreadId: "child-agent" })}>
      Stop child
    </button>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
});
it.each(["devin", "claudeAgent"])(
  "stops %s children while the parent is ready",
  async (provider) => {
    state.provider = provider;
    await render(<Controls />);
    await page.getByRole("button", { name: "Stop child" }).click();
    expect(state.dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(
        provider === "devin"
          ? { type: "thread.task.stop", threadId: "parent", taskId: "child-agent" }
          : { type: "thread.turn.interrupt", threadId: "subagent:parent:child-agent" },
      ),
    );
  },
);

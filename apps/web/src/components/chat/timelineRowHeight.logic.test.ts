import { MessageId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  createTimelineRowHeightEstimator,
  estimateTimelineRowHeight,
  rememberTimelineRowHeight,
} from "./timelineRowHeight.logic";

const LAYOUT = { rowWidthPx: 736, chatFontSizePx: 13 };

function messageRow(id: string, role: "user" | "assistant", text: string): Extract<MessagesTimelineRow, { kind: "message" }> {
  return {
    kind: "message",
    id,
    createdAt: "2026-10-11T12:00:00.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt: "2026-10-11T12:00:00.000Z",
      streaming: false,
    },
    durationStart: "2026-10-11T12:00:00.000Z",
    showAssistantCopyButton: role === "assistant",
    assistantCopyStreaming: false,
  };
}

const paragraph = "Representative transcript prose that wraps across the chat column. ".repeat(6);

describe("estimateTimelineRowHeight", () => {
  it("grows with wrapped prose, blank lines and code fences", () => {
    const short = estimateTimelineRowHeight(messageRow("a", "assistant", "Done."), LAYOUT);
    const prose = estimateTimelineRowHeight(
      messageRow("b", "assistant", `${paragraph}\n\n${paragraph}`),
      LAYOUT,
    );
    const withCode = estimateTimelineRowHeight(
      messageRow(
        "c",
        "assistant",
        `${paragraph}\n\n${paragraph}\n\n\`\`\`ts\n${"x;\n".repeat(20)}\`\`\``,
      ),
      LAYOUT,
    );
    expect(short).toBeLessThan(prose);
    expect(prose).toBeLessThan(withCode);
    // A long answer is several times the old fixed 90px guess.
    expect(prose).toBeGreaterThan(180);
  });

  it("scales with the chat font size", () => {
    const user = estimateTimelineRowHeight(messageRow("u", "user", paragraph.repeat(3)), LAYOUT);
    const larger = estimateTimelineRowHeight(messageRow("u", "user", paragraph.repeat(3)), {
      ...LAYOUT,
      chatFontSizePx: 18,
    });
    expect(larger).toBeGreaterThan(user);
  });
});

describe("createTimelineRowHeightEstimator", () => {
  it("prefers a height measured in an earlier mount for the same layout", () => {
    const row = messageRow("remembered-row", "assistant", paragraph);
    const estimate = createTimelineRowHeightEstimator(() => LAYOUT);
    const estimated = estimate(row);

    rememberTimelineRowHeight(row.id, LAYOUT, estimated + 333, row);

    expect(createTimelineRowHeightEstimator(() => LAYOUT)(row)).toBe(estimated + 333);
    // A different column width cannot reuse that measurement.
    expect(createTimelineRowHeightEstimator(() => ({ ...LAYOUT, rowWidthPx: 420 }))(row)).not.toBe(
      estimated + 333,
    );
  });

  it("re-estimates when the layout changes", () => {
    const row = messageRow("layout-row", "assistant", paragraph.repeat(4));
    let layout = LAYOUT;
    const estimate = createTimelineRowHeightEstimator(() => layout);
    const wide = estimate(row);
    layout = { ...LAYOUT, rowWidthPx: 360 };
    expect(estimate(row)).toBeGreaterThan(wide);
  });
});

describe("remembered row height ownership", () => {
  it("does not reuse a measurement after background content changes", () => {
    const before = messageRow("background-change", "assistant", "First response.");
    rememberTimelineRowHeight(before.id, LAYOUT, 1234, before);
    const after = messageRow(before.id, "assistant", paragraph.repeat(3));
    expect(createTimelineRowHeightEstimator(() => LAYOUT)(after)).toBe(
      estimateTimelineRowHeight(after, LAYOUT),
    );
  });

  it("reuses a new row wrapper only while its immutable message is unchanged", () => {
    const before = messageRow("shared-message", "assistant", paragraph);
    rememberTimelineRowHeight(before.id, LAYOUT, 777, before);
    const remounted = { ...before };
    expect(createTimelineRowHeightEstimator(() => LAYOUT)(remounted)).toBe(777);
    const anotherThread = messageRow(before.id, "assistant", paragraph);
    expect(createTimelineRowHeightEstimator(() => LAYOUT)(anotherThread)).toBe(
      estimateTimelineRowHeight(anotherThread, LAYOUT),
    );
  });

  it("does not persist expanded user-message geometry into a collapsed remount", () => {
    const row = messageRow("expanded-user", "user", paragraph.repeat(20));
    rememberTimelineRowHeight(row.id, LAYOUT, 5000, row);
    expect(createTimelineRowHeightEstimator(() => LAYOUT)({ ...row })).toBe(
      estimateTimelineRowHeight(row, LAYOUT),
    );
  });

  it("does not persist a code block's local wrapping choice", () => {
    const row = messageRow("code-wrap", "assistant", "\`\`\`ts\n" + "longLine();".repeat(50) + "\n\`\`\`");
    rememberTimelineRowHeight(row.id, LAYOUT, 2300, row);
    expect(createTimelineRowHeightEstimator(() => LAYOUT)({ ...row })).toBe(
      estimateTimelineRowHeight(row, LAYOUT),
    );
  });

  it("does not alias transient worktree rows across threads", () => {
    const before: MessagesTimelineRow = {
      kind: "worktree-setup", id: "worktree-setup-row", open: true,
      steps: [{ id: "create-worktree", label: "First checkout", status: "done" }],
    };
    rememberTimelineRowHeight(before.id, LAYOUT, 900, before);
    const after: MessagesTimelineRow = { ...before, steps: [], open: false };
    expect(createTimelineRowHeightEstimator(() => LAYOUT)(after)).toBe(
      estimateTimelineRowHeight(after, LAYOUT),
    );
  });

  it("does not reuse or overwrite measurements in a context with additional chrome", () => {
    const row = messageRow("context-chrome", "assistant", paragraph);
    rememberTimelineRowHeight(row.id, LAYOUT, 333, row);
    expect(createTimelineRowHeightEstimator(() => LAYOUT, false)(row)).toBe(
      estimateTimelineRowHeight(row, LAYOUT),
    );
    rememberTimelineRowHeight(row.id, LAYOUT, 999, row, false);
    expect(createTimelineRowHeightEstimator(() => LAYOUT)(row)).toBe(333);
  });

  it("does not use a desktop measurement before the new viewport width is known", () => {
    const row = messageRow("unknown-width", "assistant", paragraph);
    rememberTimelineRowHeight(row.id, LAYOUT, 777, row);
    let widthMeasured = false;
    const estimate = createTimelineRowHeightEstimator(() => LAYOUT, true, () => widthMeasured);
    expect(estimate(row)).toBe(estimateTimelineRowHeight(row, LAYOUT));
    widthMeasured = true;
    expect(estimate(row)).toBe(777);
  });

  it("does not retain a non-finite measured height", () => {
    const row = messageRow("invalid-height", "assistant", paragraph);
    rememberTimelineRowHeight(row.id, LAYOUT, Infinity, row);
    expect(createTimelineRowHeightEstimator(() => LAYOUT)(row)).toBe(
      estimateTimelineRowHeight(row, LAYOUT),
    );
  });
});

describe("bounded text estimation", () => {
  it("bounds both explicit character reads and newline-search input for oversized text", () => {
    const text = " ".repeat(250_000) + "Visible answer";
    const charCodeAt = vi.spyOn(String.prototype, "charCodeAt");
    const originalIndexOf = String.prototype.indexOf;
    const searchedLengths: number[] = [];
    const indexOf = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
      this: string, search: string, position?: number,
    ) {
      searchedLengths.push(this.length);
      return originalIndexOf.call(this, search, position);
    });
    let height = 0;
    let characterReads = 0;
    try {
      height = estimateTimelineRowHeight(messageRow("oversized", "assistant", text), LAYOUT);
      characterReads = charCodeAt.mock.calls.length;
    } finally {
      indexOf.mockRestore();
      charCodeAt.mockRestore();
    }
    expect(height).toBeGreaterThan(0);
    expect(Number.isFinite(height)).toBe(true);
    expect(characterReads).toBeLessThanOrEqual(8192);
    expect(Math.max(...searchedLengths)).toBeLessThanOrEqual(8192);
  });

  it("extrapolates a long unwrapped answer while preserving the user-message clamp", () => {
    const text = "x".repeat(200_000);
    const answer = estimateTimelineRowHeight(messageRow("long-answer", "assistant", text), LAYOUT);
    const prompt = estimateTimelineRowHeight(messageRow("long-prompt", "user", text), LAYOUT);
    expect(answer).toBeGreaterThan(estimateTimelineRowHeight(messageRow("sample", "assistant", text.slice(0, 4096)), LAYOUT));
    expect(prompt).toBe(estimateTimelineRowHeight(messageRow("prompt-sample", "user", text.slice(0, 4096)), LAYOUT));
  });
});

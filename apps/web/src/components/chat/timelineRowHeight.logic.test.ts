import { MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  createTimelineRowHeightEstimator,
  estimateTimelineRowHeight,
  rememberTimelineRowHeight,
} from "./timelineRowHeight.logic";

const LAYOUT = { rowWidthPx: 736, chatFontSizePx: 13 };

function messageRow(id: string, role: "user" | "assistant", text: string): MessagesTimelineRow {
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

    rememberTimelineRowHeight(row.id, LAYOUT, estimated + 333);

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

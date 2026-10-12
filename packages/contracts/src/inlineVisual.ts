import { Schema } from "effect";

import { NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

/**
 * Inline visuals: a self-contained HTML document (chart, table, diagram, small
 * interactive view) that an agent publishes into its own thread with the
 * `synara_show_visual` gateway tool. The server stores the document and records
 * a small `visual.shown` activity; clients fetch the document by id and run it
 * in a sandboxed, network-less frame inside the transcript.
 */
export const INLINE_VISUAL_TOOL_NAME = "synara_show_visual";
export const INLINE_VISUAL_ACTIVITY_KIND = "visual.shown";

/** Kept well under the 1 MiB gateway request limit, since JSON escaping can double HTML. */
export const INLINE_VISUAL_MAX_HTML_BYTES = 256 * 1024;
export const INLINE_VISUAL_MAX_TITLE_LENGTH = 120;
export const INLINE_VISUAL_MIN_HEIGHT = 80;
export const INLINE_VISUAL_MAX_HEIGHT = 1600;
export const INLINE_VISUAL_DEFAULT_HEIGHT = 320;

export const InlineVisualId = Schema.String.check(Schema.isPattern(/^vis_[0-9a-f]{32}$/));
export type InlineVisualId = typeof InlineVisualId.Type;

/** What the `visual.shown` activity carries. The document itself is fetched separately. */
export const InlineVisualActivityPayload = Schema.Struct({
  visualId: InlineVisualId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(INLINE_VISUAL_MAX_TITLE_LENGTH)),
  /** The agent's expected height, reserved until the page reports its own. */
  height: Schema.Int.check(
    Schema.isBetween({ minimum: INLINE_VISUAL_MIN_HEIGHT, maximum: INLINE_VISUAL_MAX_HEIGHT }),
  ),
  byteLength: NonNegativeInt.check(Schema.isLessThanOrEqualTo(INLINE_VISUAL_MAX_HTML_BYTES)),
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type InlineVisualActivityPayload = typeof InlineVisualActivityPayload.Type;

export const OrchestrationGetInlineVisualInput = Schema.Struct({
  threadId: ThreadId,
  visualId: InlineVisualId,
});
export type OrchestrationGetInlineVisualInput = typeof OrchestrationGetInlineVisualInput.Type;

export const OrchestrationGetInlineVisualResult = Schema.Struct({
  visualId: InlineVisualId,
  html: Schema.String,
});
export type OrchestrationGetInlineVisualResult = typeof OrchestrationGetInlineVisualResult.Type;

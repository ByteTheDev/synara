// FILE: inlineVisualTools.ts
// Purpose: The `synara_show_visual` gateway tool: an agent publishes a self-contained HTML
//          visual into its own running turn, shown inline above its final reply.
// Layer: Agent Gateway tool (provider-neutral; every provider with the thread-scoped gateway)
// Exports: makeAgentGatewayInlineVisualTools, INLINE_VISUALS_PER_TURN_LIMIT

import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";

import {
  INLINE_VISUAL_DEFAULT_HEIGHT,
  INLINE_VISUAL_MAX_HEIGHT,
  INLINE_VISUAL_MAX_HTML_BYTES,
  INLINE_VISUAL_MAX_TITLE_LENGTH,
  INLINE_VISUAL_MIN_HEIGHT,
  INLINE_VISUAL_TOOL_NAME,
  type InlineVisualActivityPayload,
} from "@synara/contracts";
import { Effect } from "effect";

import { writeInlineVisual } from "../inlineVisualStore.ts";
import { stableGatewayDigest } from "./creationUtils.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import { ToolInputError, errorText, readNumberArg } from "./toolInput.ts";
import type { ToolEntry } from "./toolRuntime.ts";

/** A turn that keeps publishing visuals is almost certainly looping; refuse past this. */
export const INLINE_VISUALS_PER_TURN_LIMIT = 6;
const TRACKED_TURNS_MAX = 512;

const DESCRIPTION = [
  "Show a finished visual - a chart, table, diagram, or small interactive view - inline in this chat, above your final reply. Call it before writing that reply.",
  "The reader sees the visual, so keep the reply brief: state the key finding in words and do not describe the visual or say where it is.",
  "Send one complete, self-contained HTML document with inline <style> and <script>.",
  "The page has no network: remote URLs, fetch, external scripts, fonts, and images do not load. Draw with inline SVG, canvas, or HTML, and embed images as data: URIs.",
  "Link clicks open http(s) URLs in the reader's browser; the page cannot navigate, open windows, or show dialogs, and storage is in-memory only.",
  "Theme variables on :root follow the app's light/dark theme: --background --foreground --muted --muted-foreground --card --card-foreground --border --primary --primary-foreground --accent --accent-foreground --destructive --warning --success --info --ring --series-1 to --series-6 (categorical chart colors) --radius --font-sans --font-mono --font-size.",
  "The frame is borderless on the chat background, as wide as the reply column (728px on desktop, wider if the reader widens chat, about 360px on phones), and lines up with your reply text. The title is not shown; it names the visual for screen readers, so put a short heading in the page when the visual needs one.",
  "The page is part of your reply: no outer card, border, padding, or banner title, and leave html and body without a background. A box that needs its own background gets at least 16px of padding and var(--radius) corners.",
  'Draw at natural size rather than stretching to the frame: keep text at the inherited font size, never scaled with the width. Give inline SVG width and height attributes equal to its viewBox plus max-width:100%;height:auto, and never use preserveAspectRatio="none".',
  "Size charts to their data: bars 14-20px thick with each value right after its bar, a plot area no wider than about 480px, and a handful of points kept compact instead of spread across the column. Use fixed pixel heights and no 100vh; the frame fits the page's height.",
  "Style controls with the theme variables (for example accent-color: var(--primary)). Respect prefers-reduced-motion.",
].join(" ");

interface InlineVisualDraft {
  readonly title: string;
  readonly html: string;
  readonly height: number;
  readonly byteLength: number;
}

function readInlineVisualDraft(args: Record<string, unknown>): InlineVisualDraft {
  const rawTitle = args.title;
  if (typeof rawTitle !== "string") {
    throw new ToolInputError('Argument "title" must be a non-empty string.');
  }
  // Control characters would render as junk in the transcript label.
  const title = rawTitle
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length === 0) {
    throw new ToolInputError('Argument "title" must be a non-empty string.');
  }
  if (title.length > INLINE_VISUAL_MAX_TITLE_LENGTH) {
    throw new ToolInputError(
      `Argument "title" must be at most ${INLINE_VISUAL_MAX_TITLE_LENGTH} characters.`,
    );
  }
  const html = args.html;
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new ToolInputError('Argument "html" must be a non-empty HTML document.');
  }
  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength > INLINE_VISUAL_MAX_HTML_BYTES) {
    throw new ToolInputError(
      `The page is ${Math.ceil(byteLength / 1024)} KiB; the limit is ${INLINE_VISUAL_MAX_HTML_BYTES / 1024} KiB. Remove embedded data or simplify the page.`,
    );
  }
  const requestedHeight = readNumberArg(args, "height");
  const height = Math.min(
    INLINE_VISUAL_MAX_HEIGHT,
    Math.max(INLINE_VISUAL_MIN_HEIGHT, Math.round(requestedHeight ?? INLINE_VISUAL_DEFAULT_HEIGHT)),
  );
  return { title, html, height, byteLength };
}

export interface AppendInlineVisualActivityInput {
  readonly threadId: string;
  readonly turnId: string;
  /** Stable for identical content in the same turn, so a retried call is the same command. */
  readonly digest: string;
  readonly payload: InlineVisualActivityPayload;
}

export interface InlineVisualToolsInput {
  readonly attachmentsDir: string;
  /**
   * Records the visual on the caller's thread. Succeeds when this exact visual
   * was already recorded by an earlier attempt of the same call.
   */
  readonly appendVisualActivity: (
    input: AppendInlineVisualActivityInput,
  ) => Effect.Effect<void, unknown>;
}

export function makeAgentGatewayInlineVisualTools(
  input: InlineVisualToolsInput,
): ReadonlyArray<ToolEntry> {
  // Visual ids published per running turn. In memory only: a restart resets
  // the count, which is fine for a guard against a looping agent.
  const visualsByTurn = new Map<string, Set<string>>();
  const turnVisuals = (key: string) => {
    let visuals = visualsByTurn.get(key);
    if (visuals === undefined) {
      while (visualsByTurn.size >= TRACKED_TURNS_MAX) {
        visualsByTurn.delete(visualsByTurn.keys().next().value!);
      }
      visuals = new Set();
      visualsByTurn.set(key, visuals);
    }
    return visuals;
  };

  const showVisual: ToolEntry = {
    requiredCapability: "thread:write",
    requiresActiveTurn: true,
    definition: {
      name: INLINE_VISUAL_TOOL_NAME,
      description: DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            minLength: 1,
            maxLength: INLINE_VISUAL_MAX_TITLE_LENGTH,
            description: "Short name for the visual; also its accessible name.",
          },
          html: {
            type: "string",
            minLength: 1,
            description: `One complete, self-contained HTML document, at most ${INLINE_VISUAL_MAX_HTML_BYTES / 1024} KiB.`,
          },
          height: {
            type: "integer",
            minimum: INLINE_VISUAL_MIN_HEIGHT,
            maximum: INLINE_VISUAL_MAX_HEIGHT,
            description: `Expected height in CSS pixels at the 728px column. Space is reserved at this height until the page reports its own. Defaults to ${INLINE_VISUAL_DEFAULT_HEIGHT}.`,
          },
        },
        required: ["title", "html"],
        additionalProperties: false,
      },
      annotations: {
        title: "Show a visual",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const draft = yield* Effect.try({
          try: () => readInlineVisualDraft(args),
          catch: (cause) => cause,
        });
        const turnId = context.callerTurnId;
        if (turnId === null) {
          return yield* Effect.fail(
            new ToolInputError("Visuals can only be shown during an active turn."),
          );
        }
        const sha256 = createHash("sha256").update(draft.html, "utf8").digest("hex");
        const digest = stableGatewayDigest({
          kind: "inline-visual",
          threadId: context.callerThreadId,
          turnId,
          sha256,
          title: draft.title,
          height: draft.height,
        });
        const visualId = `vis_${digest}`;
        const turnKey = `${context.callerThreadId}\u0000${turnId}`;
        const published = turnVisuals(turnKey);
        if (!published.has(visualId) && published.size >= INLINE_VISUALS_PER_TURN_LIMIT) {
          return yield* Effect.fail(
            new ToolInputError(
              `This turn already shows ${INLINE_VISUALS_PER_TURN_LIMIT} visuals. Combine them into one page instead.`,
            ),
          );
        }

        const stored = yield* Effect.tryPromise({
          try: () =>
            writeInlineVisual({
              attachmentsDir: input.attachmentsDir,
              threadId: context.callerThreadId,
              visualId,
              html: draft.html,
            }),
          catch: (cause) =>
            new ToolInputError(`The visual could not be saved: ${errorText(cause)}`),
        });
        // Only a file this call created is removed on failure: an identical
        // retry shares the id, and its earlier success must keep its page.
        const discardNewFile = Effect.promise(() =>
          stored.existed ? Promise.resolve() : rm(stored.filePath, { force: true }),
        );

        // Stop may have ended the turn while the page was written; a stopped
        // turn must not gain a row.
        yield* context.assertCallerTurnActive().pipe(Effect.tapError(() => discardNewFile));
        yield* input
          .appendVisualActivity({
            threadId: context.callerThreadId,
            turnId,
            digest,
            payload: {
              visualId,
              title: draft.title,
              height: draft.height,
              byteLength: draft.byteLength,
              sha256,
            },
          })
          .pipe(
            Effect.tapError(() => discardNewFile),
            Effect.mapError(
              (cause) => new ToolInputError(`The visual could not be shown: ${errorText(cause)}`),
            ),
          );
        published.add(visualId);
        return mcpToolResultJson({
          visualId,
          title: draft.title,
          message:
            "Shown to the reader above your reply. State the key finding in words; do not describe the visual or say where it is.",
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  return [showVisual];
}

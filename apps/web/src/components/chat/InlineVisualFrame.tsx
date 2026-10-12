// FILE: InlineVisualFrame.tsx
// Purpose: One agent-published inline visual in the transcript: fetches its document, runs it
//          in a sandboxed srcdoc frame, and bridges size, links, theme, and scroll intent.
// Layer: Chat transcript row content
// Exports: InlineVisualFrame

import type { InlineVisualActivityPayload, ThreadId } from "@synara/contracts";
import {
  buildInlineVisualDocument,
  clampInlineVisualHeight,
  inlineVisualLinkResult,
  inlineVisualThemeMessage,
  readInlineVisualFrameMessage,
  type InlineVisualTheme,
} from "@synara/shared/inlineVisual";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useInlineVisualTheme } from "~/hooks/useInlineVisualTheme";
import { DISCLOSURE_FADE_MOTION_CLASS } from "~/lib/disclosureMotion";
import { RotateCcwIcon } from "~/lib/icons";
import { openExternalLink } from "~/lib/linkChips";
import { inlineVisualQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { CopyTextButton } from "../ui/copyTextButton";
import { IconButton } from "../ui/icon-button";

/**
 * An inline visual. The box holds the agent's expected height while the
 * document loads, then fits the height the page reports, so the transcript
 * grows once rather than jumping. Growth only re-measures the list row; it is
 * never a follow signal. A reader who scrolls over the frame still detaches
 * follow through `onScrollIntent`, since those gestures never reach the host.
 */
export function InlineVisualFrame({
  threadId,
  visual,
  onScrollIntent,
}: {
  readonly threadId: ThreadId;
  readonly visual: InlineVisualActivityPayload;
  readonly onScrollIntent?: ((upward: boolean) => void) | undefined;
}) {
  const theme = useInlineVisualTheme();
  const visualDocument = useQuery(
    inlineVisualQueryOptions({ threadId, visualId: visual.visualId }),
  );
  // Reload mounts a fresh frame (and clears a stopped one) without refetching.
  const [generation, setGeneration] = useState(0);
  const [stopped, setStopped] = useState(false);
  const reload = () => {
    setStopped(false);
    setGeneration((value) => value + 1);
  };
  const html = visualDocument.data;

  return (
    <figure className="group/inline-visual relative m-0 min-w-0" aria-label={visual.title}>
      <div className="flex min-h-6 items-center gap-1">
        <figcaption className="min-w-0 flex-1 truncate text-muted-foreground text-ui-xs">
          {visual.title}
        </figcaption>
        {html !== undefined && !stopped ? (
          <div
            className={cn(
              DISCLOSURE_FADE_MOTION_CLASS,
              "flex items-center gap-0.5 opacity-0 focus-within:opacity-100 group-hover/inline-visual:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            <CopyTextButton text={html} label="source" className="text-ui-xs" />
            <IconButton label="Reload visual" tooltip="Reload" onClick={reload}>
              <RotateCcwIcon className="size-3.5" />
            </IconButton>
          </div>
        ) : null}
      </div>
      {html !== undefined && !stopped ? (
        <InlineVisualDocument
          key={`${visual.visualId}:${generation}`}
          html={html}
          title={visual.title}
          reservedHeight={visual.height}
          theme={theme}
          onStopped={() => setStopped(true)}
          onScrollIntent={onScrollIntent}
        />
      ) : stopped ? (
        <InlineVisualNotice
          message="This visual stopped because it tried to leave the page."
          action="Reload"
          onAction={reload}
        />
      ) : visualDocument.isError ? (
        <InlineVisualNotice
          message="Visual unavailable."
          {...(isRetryable(visualDocument.error)
            ? { action: "Retry", onAction: () => void visualDocument.refetch() }
            : {})}
        />
      ) : (
        <div
          className="flex items-center justify-center rounded-lg bg-muted/40 text-muted-foreground text-ui-xs"
          style={{ height: clampInlineVisualHeight(visual.height) }}
          role="status"
        >
          Loading visual…
        </div>
      )}
    </figure>
  );
}

function isRetryable(error: unknown): boolean {
  return (error as { retryable?: unknown } | null)?.retryable !== false;
}

function InlineVisualNotice(props: {
  readonly message: string;
  readonly action?: string;
  readonly onAction?: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-muted-foreground text-ui-sm"
      role="status"
    >
      <span className="min-w-0 flex-1">{props.message}</span>
      {props.action && props.onAction ? (
        <Button size="xs" variant="outline" onClick={props.onAction}>
          {props.action}
        </Button>
      ) : null}
    </div>
  );
}

function InlineVisualDocument({
  html,
  title,
  reservedHeight,
  theme,
  onStopped,
  onScrollIntent,
}: {
  readonly html: string;
  readonly title: string;
  readonly reservedHeight: number;
  readonly theme: InlineVisualTheme;
  readonly onStopped: () => void;
  readonly onScrollIntent?: ((upward: boolean) => void) | undefined;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Built once per mount with the theme of that moment; later theme changes
  // arrive as messages, since a new srcdoc would reload the page and lose its
  // state. The parent keys this component by visual id and reload count.
  const [srcDoc] = useState(() => buildInlineVisualDocument(html, theme));
  const callbacks = useRef({ onStopped, onScrollIntent });
  const loads = useRef(0);
  useLayoutEffect(() => {
    callbacks.current = { onStopped, onScrollIntent };
  });

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(inlineVisualThemeMessage(theme), "*");
  }, [theme]);

  // Registered in the commit that inserts the frame: a fast page can post its
  // first size before a passive effect would run.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      // Only the frame's own window; the page's origin is opaque, so this is
      // the only way to tell its messages from anyone else's.
      if (frame === null || event.source === null || event.source !== frame.contentWindow) {
        return;
      }
      const message = readInlineVisualFrameMessage(event.data);
      if (message === undefined) return;
      if (message.type === "size") {
        setContentHeight(clampInlineVisualHeight(message.height));
      } else if (message.type === "scroll-intent") {
        callbacks.current.onScrollIntent?.(message.upward);
      } else if (
        // A page can post this at any time; open only right after the reader
        // used this frame. It can still wait for the reader's next click.
        document.activeElement === frame &&
        navigator.userActivation?.isActive !== false
      ) {
        openExternalLink(message.url);
        frame.contentWindow?.postMessage(inlineVisualLinkResult(message.id), "*");
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const onLoad = () => {
    // srcdoc loads exactly once. A second load means the page navigated its
    // own frame (desktop blocks that; a browser cannot), so stop showing it.
    loads.current += 1;
    if (loads.current > 1) {
      callbacks.current.onStopped();
      return;
    }
    setLoaded(true);
    // Covers a theme change that landed while the page was parsing.
    frameRef.current?.contentWindow?.postMessage(inlineVisualThemeMessage(theme), "*");
  };
  const height = contentHeight ?? clampInlineVisualHeight(reservedHeight);
  const colorScheme = loaded ? theme.appearance : "light";
  return (
    <iframe
      ref={frameRef}
      srcDoc={srcDoc}
      title={title}
      // Never allow-same-origin: the opaque origin keeps the page away from the
      // app's storage, cookies, and DOM. No popups, modals, downloads, or top
      // navigation; forms only so submit handlers run (CSP blocks submission).
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      className="block w-full rounded-lg border-0 bg-transparent"
      // A frame whose color scheme differs from its document's paints an
      // opaque canvas, so the blank document would flash until the page is in.
      style={{ height, colorScheme }}
      data-inline-visual-frame=""
    />
  );
}

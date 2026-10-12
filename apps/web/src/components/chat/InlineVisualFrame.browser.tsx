import "../../index.css";

import { type InlineVisualActivityPayload, type NativeApi, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useTheme } from "~/hooks/useTheme";

import { InlineVisualFrame } from "./InlineVisualFrame";

const THREAD_ID = ThreadId.makeUnsafe("thread-inline-visual");

function visual(id: string, height = 240): InlineVisualActivityPayload {
  return {
    visualId: `vis_${id.repeat(32).slice(0, 32)}`,
    title: `Visual ${id}`,
    height,
    byteLength: 100,
    sha256: "f".repeat(64),
  };
}

// Pages report what they observed with postMessage, the one channel an
// opaque-origin page has; the test reads only messages that carry `probe`.
const probes: Array<Record<string, unknown>> = [];
const recordProbe = (event: MessageEvent) => {
  if (event.data && typeof event.data === "object" && "probe" in event.data) {
    probes.push(event.data as Record<string, unknown>);
  }
};
window.addEventListener("message", recordProbe);

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  probes.length = 0;
  vi.unstubAllGlobals();
});

async function mount(
  pages: Record<string, string | (() => Promise<string>)>,
  shown: InlineVisualActivityPayload,
  options: { onScrollIntent?: (upward: boolean) => void; children?: React.ReactNode } = {},
) {
  const getInlineVisual = vi.fn(async ({ visualId }: { visualId: string }) => {
    const source = pages[visualId];
    const html = typeof source === "function" ? await source() : source;
    if (html === undefined) throw new Error("missing");
    return { visualId, html };
  });
  const openExternal = vi.fn(async () => {});
  vi.stubGlobal("nativeApi", {
    orchestration: { getInlineVisual },
    shell: { openExternal },
  } as unknown as NativeApi);
  const client = new QueryClient();
  const tree = (
    current: InlineVisualActivityPayload,
    onScrollIntent: ((upward: boolean) => void) | undefined,
  ) => (
    <QueryClientProvider client={client}>
      <div style={{ width: 720 }}>
        <InlineVisualFrame threadId={THREAD_ID} visual={current} onScrollIntent={onScrollIntent} />
        {options.children}
      </div>
    </QueryClientProvider>
  );
  const screen = await render(tree(shown, options.onScrollIntent));
  cleanup = async () => {
    await screen.unmount();
    client.clear();
  };
  // What a transcript update hands an unchanged row: an equal payload decoded
  // into a new object, and fresh callbacks.
  const rerenderAsTranscriptUpdate = () => screen.rerender(tree({ ...shown }, () => {}));
  return { screen, getInlineVisual, openExternal, rerenderAsTranscriptUpdate };
}

const frame = () => document.querySelector<HTMLIFrameElement>("iframe[data-inline-visual-frame]");

it("renders a chart and fits the frame to the page's own height", async () => {
  const chart = visual("1", 120);
  await mount(
    {
      [chart.visualId]: `<div style="height:437px"><svg width="600" height="400" role="img" aria-label="Revenue">
        <rect x="10" y="100" width="80" height="300" fill="var(--series-1)"></rect></svg></div>`,
    },
    chart,
  );

  await expect.poll(() => frame()?.getAttribute("sandbox")).toBe("allow-scripts allow-forms");
  await expect.poll(() => frame()?.getBoundingClientRect().height).toBe(437);
  expect(frame()?.getAttribute("src")).toBeNull();
  expect(frame()?.title).toBe("Visual 1");
});

it("runs page scripts but keeps them away from the app, the network, and new windows", async () => {
  const probe = visual("2");
  // The page opens with a script: the policy must already apply to it.
  const html = `<script>
    const violations = [];
    document.addEventListener("securitypolicyviolation", (event) => violations.push(event.effectiveDirective));
    const result = {};
    try { result.parentDocument = typeof parent.document; } catch (error) { result.parentDocument = error.name; }
    try { result.cookie = document.cookie; } catch (error) { result.cookie = error.name; }
    result.open = String(window.open("https://example.com/popup"));
    localStorage.setItem("k", "v");
    result.storage = localStorage.getItem("k");
    // Same server as the app: without the policy this request would succeed.
    const sameServer = new URL("/", document.baseURI).href;
    fetch(sameServer, { mode: "no-cors" }).then(() => "loaded", (error) => error.name).then((fetched) => {
      const image = new Image();
      image.onload = image.onerror = () => setTimeout(() => {
        parent.postMessage({ probe: "isolation", ...result, fetched, violations: [...new Set(violations)].sort() }, "*");
      }, 50);
      image.src = sameServer + "favicon.ico";
    });
  </script><p>probe</p>`;
  await mount({ [probe.visualId]: html }, probe);

  await expect.poll(() => probes.find((entry) => entry.probe === "isolation")).toBeTruthy();
  const result = probes.find((entry) => entry.probe === "isolation")!;
  expect(result.parentDocument).toBe("SecurityError");
  expect(result.cookie).toBe("SecurityError");
  expect(result.open).toBe("null");
  expect(result.storage).toBe("v");
  expect(result.fetched).toBe("TypeError");
  expect(result.violations).toEqual(["connect-src", "img-src"]);
});

it("stops a page that navigates its own frame", async () => {
  const runaway = visual("3");
  await mount(
    {
      [runaway.visualId]: `<p>leaving</p><script>setTimeout(() => { location.href = "data:text/html,<p>away</p>"; }, 30);</script>`,
    },
    runaway,
  );

  await expect
    .element(page.getByText("This visual stopped because it tried to leave the page."))
    .toBeVisible();
  expect(frame()).toBeNull();
});

it("opens a link only from the reader's own click", async () => {
  const links = visual("4", 200);
  const { openExternal } = await mount(
    {
      [links.visualId]: `<a href="https://example.com/docs" style="display:block;height:200px">Docs</a>
        <script>
          // An unsolicited request at load must be ignored.
          parent.postMessage({ jsonrpc: "2.0", id: "sneaky", method: "ui/open-link", params: { url: "https://example.com/sneaky" } }, "*");
          addEventListener("load", () => parent.postMessage({ probe: "links-ready" }, "*"));
        </script>`,
    },
    links,
  );
  await expect.poll(() => probes.some((entry) => entry.probe === "links-ready")).toBe(true);
  expect(openExternal).not.toHaveBeenCalled();

  await userEvent.click(frame()!);

  await expect.poll(() => openExternal.mock.calls.length).toBe(1);
  expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  expect(frame()).not.toBeNull();
});

it("keeps a page's interactive state across transcript updates", async () => {
  const counter = visual("8", 200);
  const { getInlineVisual, rerenderAsTranscriptUpdate } = await mount(
    {
      [counter.visualId]: `<button id="counter" style="width:100%;height:200px">0</button><script>
        let count = 0;
        counter.onclick = () => { counter.textContent = String(++count); };
        addEventListener("message", (event) => {
          if (event.data && event.data.report) parent.postMessage({ probe: "count", count }, "*");
        });
        addEventListener("load", () => parent.postMessage({ probe: "counter-loaded" }, "*"));
      </script>`,
    },
    counter,
  );
  await expect.poll(() => probes.some((entry) => entry.probe === "counter-loaded")).toBe(true);
  const countReported = async () => {
    probes.length = 0;
    frame()!.contentWindow!.postMessage({ report: true }, "*");
    await expect.poll(() => probes.find((entry) => entry.probe === "count")).toBeTruthy();
    return probes.find((entry) => entry.probe === "count")!.count;
  };

  await userEvent.click(frame()!);
  expect(await countReported()).toBe(1);
  const running = frame();

  await rerenderAsTranscriptUpdate();
  await new Promise((resolve) => setTimeout(resolve, 100));

  expect(frame()).toBe(running);
  expect(await countReported()).toBe(1);
  expect(probes.some((entry) => entry.probe === "counter-loaded")).toBe(false);
  expect(getInlineVisual).toHaveBeenCalledTimes(1);
});

it("follows a theme change without reloading the page", async () => {
  const themed = visual("5");
  let setTheme: ((mode: "light" | "dark") => void) | null = null;
  function ThemeControl() {
    const theme = useTheme();
    useEffect(() => {
      setTheme = theme.setTheme;
    });
    return null;
  }
  const initialMode = localStorage.getItem("synara:theme");
  const { getInlineVisual } = await mount(
    {
      [themed.visualId]: `<p>themed</p><script>
        const report = (reason) => parent.postMessage({ probe: "theme", reason,
          scheme: getComputedStyle(document.documentElement).colorScheme,
          foreground: getComputedStyle(document.documentElement).getPropertyValue("--foreground").trim() }, "*");
        addEventListener("load", () => report("load"));
        addEventListener("message", (event) => {
          if (event.data && event.data.method === "ui/notifications/host-context-changed") setTimeout(() => report("change"), 0);
        });
      </script>`,
    },
    themed,
    { children: <ThemeControl /> },
  );
  try {
    await expect.poll(() => probes.some((entry) => entry.reason === "load")).toBe(true);
    setTheme!("dark");
    await expect
      .poll(() => probes.findLast((entry) => entry.probe === "theme")?.scheme)
      .toBe("dark");
    const dark = probes.findLast((entry) => entry.probe === "theme")!;
    setTheme!("light");
    await expect
      .poll(() => probes.findLast((entry) => entry.probe === "theme")?.scheme)
      .toBe("light");
    const light = probes.findLast((entry) => entry.probe === "theme")!;

    expect(light.foreground).not.toBe(dark.foreground);
    expect(probes.filter((entry) => entry.reason === "load")).toHaveLength(1);
    expect(getInlineVisual).toHaveBeenCalledTimes(1);
    expect(page.getByText("This visual stopped", { exact: false }).query()).toBeNull();
  } finally {
    if (initialMode === null) localStorage.removeItem("synara:theme");
    else localStorage.setItem("synara:theme", initialMode);
  }
});

it("forwards a wheel over the page so the transcript can release follow", async () => {
  const scrollable = visual("6", 300);
  const onScrollIntent = vi.fn();
  await mount(
    {
      [scrollable.visualId]: `<div style="height:300px">wheel here</div><script>
        addEventListener("load", () => parent.postMessage({ probe: "wheel-ready" }, "*"));
      </script>`,
    },
    scrollable,
    { onScrollIntent },
  );
  await expect.poll(() => probes.some((entry) => entry.probe === "wheel-ready")).toBe(true);

  await userEvent.wheel(frame()!, { delta: { y: -120 } });
  await expect.poll(() => onScrollIntent.mock.calls.at(-1)).toEqual([true]);

  // Another window cannot fake the frame's messages.
  window.postMessage(
    { jsonrpc: "2.0", method: "synara/notifications/scroll-intent", params: { upward: false } },
    "*",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(onScrollIntent.mock.calls.every(([upward]) => upward === true)).toBe(true);
});

it("explains a visual that can no longer be loaded, and retries a transient failure", async () => {
  const missing = visual("7", 500);
  let failures = 0;
  const { getInlineVisual } = await mount(
    {
      [missing.visualId]: async () => {
        failures += 1;
        if (failures <= 3) throw Object.assign(new Error("socket closed"), { retryable: true });
        return "<p>recovered</p><script>parent.postMessage({ probe: 'recovered' }, '*')</script>";
      },
    },
    missing,
  );

  await expect.element(page.getByText("Visual unavailable.")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => probes.some((entry) => entry.probe === "recovered")).toBe(true);
  expect(getInlineVisual).toHaveBeenCalledTimes(4);
});

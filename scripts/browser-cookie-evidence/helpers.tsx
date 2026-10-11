const cookieEvidenceTarget = import.meta.env.VITE_COOKIE_TARGET;
const cookieEvidenceOutput = import.meta.env.VITE_COOKIE_OUTPUT;
const cookieEvidenceSource = import.meta.env.VITE_COOKIE_SOURCE;
const cookieEvidenceVariant = import.meta.env.VITE_COOKIE_VARIANT;
if (
  typeof cookieEvidenceTarget !== "string" ||
  typeof cookieEvidenceOutput !== "string" ||
  typeof cookieEvidenceSource !== "string" ||
  !["before", "after"].includes(cookieEvidenceVariant)
)
  throw new Error("Missing exact cookie evidence target.");

let cookieEvidenceTheme: Awaited<ReturnType<typeof render>> | null = null;
let cookieEvidencePreviousBridge: typeof window.desktopBridge;
let cookieEvidenceBridge: typeof window.desktopBridge;
function CookieEvidenceTheme() {
  const { setTheme } = useEvidenceTheme();
  useEvidenceEffect(() => setTheme("light"), [setTheme]);
  return null;
}
evidenceBeforeEach(async () => {
  cookieEvidencePreviousBridge = window.desktopBridge;
  cookieEvidenceBridge = {
    ...cookieEvidencePreviousBridge,
    setTheme: async () => {},
  } as NonNullable<typeof window.desktopBridge>;
  window.desktopBridge = cookieEvidenceBridge;
  cookieEvidenceTheme = await render(<CookieEvidenceTheme />);
  await vi.waitFor(() => {
    expect(document.documentElement.getAttribute("data-theme-variant")).toBe("light");
    expect(document.documentElement.style.getPropertyValue("--background").trim()).not.toBe("");
  });
});
evidenceAfterEach(async () => {
  await cookieEvidenceTheme?.unmount();
  cookieEvidenceTheme = null;
  // The canonical Safari afterEach may already have restored the original bridge.
  if (window.desktopBridge === cookieEvidenceBridge) {
    if (cookieEvidencePreviousBridge) window.desktopBridge = cookieEvidencePreviousBridge;
    else delete window.desktopBridge;
  }
  cookieEvidenceBridge = undefined;
});

async function observeCookieEvidence(
  phase: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  // Capture the actual completed finite CSS transitions without changing them.
  // The shared dialog's 200ms transition is independent of reduced-motion input.
  await vi.waitFor(
    () => {
      const running = document
        .getAnimations()
        .filter(
          (animation) =>
            Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
            (animation.pending || animation.playState === "running"),
        );
      expect(running).toHaveLength(0);
    },
    { timeout: 2_000 },
  );
  const geometry = (element: Element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  };
  const observation = {
    phase,
    target: cookieEvidenceTarget,
    source: cookieEvidenceSource,
    variant: cookieEvidenceVariant,
    viewport: { width: innerWidth, height: innerHeight },
    time: new Date().toISOString(),
    performanceNow: performance.now(),
    theme: document.documentElement.getAttribute("data-theme-variant"),
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    documentWidth: document.documentElement.scrollWidth,
    dialog: Array.from(document.querySelectorAll('[role="dialog"]')).map((element) => ({
      text: element.textContent,
      opacity: getComputedStyle(element).opacity,
      box: geometry(element),
    })),
    selects: Array.from(document.querySelectorAll("select")).map((element) => ({
      label: element.getAttribute("aria-label"),
      value: element.value,
      options: Array.from(element.options).map((option) => ({
        value: option.value,
        text: option.text,
        disabled: option.disabled,
      })),
      box: geometry(element),
    })),
    buttons: Array.from(document.querySelectorAll("button")).map((element) => ({
      text: element.textContent,
      label: element.getAttribute("aria-label"),
      disabled: element.disabled,
    })),
    checkboxes: Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
    ).map((element) => ({ checked: element.checked, disabled: element.disabled })),
    status: Array.from(document.querySelectorAll('[role="status"]')).map(
      (element) => element.textContent,
    ),
    details,
  };
  await page.screenshot({ path: cookieEvidenceOutput + "/" + phase + ".png" });
  console.log("COOKIE_EVIDENCE_OBSERVATION " + JSON.stringify(observation));
}

import { beforeEach as evidenceBeforeEach, afterEach as evidenceAfterEach } from "vitest";
import { useEffect as useEvidenceEffect } from "react";
import { useTheme as useEvidenceTheme } from "../hooks/useTheme";
import "../index.css";
import type { DesktopBridge } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useAnnouncementSheetSlotStore } from "./announcementSheetSlot";
import { useOnboardingDialogStore } from "../onboarding/onboardingDialogStore";
import {
  SafariAccessOnboarding,
  SafariAccessSetupButton,
  SAFARI_ACCESS_STORAGE_KEY,
} from "./SafariAccessOnboarding";

const originalBridge = window.desktopBridge;
const api = {
  getInfo: vi.fn(async () => ({
    supported: true as const,
    appName: "Synara (Dev)",
    appPath: "/Applications/Synara (Dev).app",
  })),
  openSettings: vi.fn(async () => true),
  revealApp: vi.fn(async () => true),
};

beforeEach(() => {
  useAnnouncementSheetSlotStore.setState({ owner: null, handedOff: false });
  useOnboardingDialogStore.setState({
    startupGateSettled: true,
    isOpen: false,
    betaWelcomePending: false,
  });
  vi.clearAllMocks();
  localStorage.removeItem(SAFARI_ACCESS_STORAGE_KEY);
  window.desktopBridge = { safariAccess: api } as unknown as DesktopBridge;
});
afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  localStorage.removeItem(SAFARI_ACCESS_STORAGE_KEY);
});

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

function Harness() {
  return (
    <>
      <SafariAccessOnboarding startup>
        <p>Next welcome</p>
      </SafariAccessOnboarding>
      <SafariAccessSetupButton />
    </>
  );
}

describe("Safari access onboarding", () => {
  it("opens manual setup despite a pending startup gate and an occupied slot", async () => {
    localStorage.setItem(SAFARI_ACCESS_STORAGE_KEY, JSON.stringify("later"));
    useOnboardingDialogStore.setState({ startupGateSettled: false });
    useAnnouncementSheetSlotStore.setState({ owner: "startup-surface", handedOff: false });
    const screen = await render(<Harness />);
    try {
      await expect.element(page.getByText("Next welcome")).toBeVisible();
      await page.getByRole("button", { name: "Safari import setup" }).click();
      await expect.element(page.getByRole("dialog")).toBeVisible();
      // Reopening setup must preserve the caller and leave startup ownership alone.
      await expect.element(page.getByText("Next welcome")).toBeVisible();
      expect(useAnnouncementSheetSlotStore.getState().owner).toBe("startup-surface");
      expect(JSON.parse(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)!)).toBe("later");
      await page.getByRole("button", { name: "Open System Settings" }).click();
      await expect.element(page.getByRole("status")).toHaveTextContent("quit and reopen");
      await page.getByRole("button", { name: "Not now", exact: true }).click();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(JSON.parse(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)!)).toBe("later");
      expect(useAnnouncementSheetSlotStore.getState().owner).toBe("startup-surface");
    } finally {
      await screen.unmount();
    }
  });
  it("keeps follow-on surfaces mounted after handoff and allows a manual Safari revisit", async () => {
    useAnnouncementSheetSlotStore.setState({ handedOff: true });
    const screen = await render(<Harness />);
    try {
      await expect.element(page.getByText("Next welcome")).toBeVisible();
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
      await page.getByRole("button", { name: "Safari import setup" }).click();
      await expect.element(page.getByRole("dialog")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
  it("waits for the shared slot without acknowledging the Safari intro", async () => {
    useAnnouncementSheetSlotStore.getState().claim("onboarding");
    const screen = await render(<Harness />);
    try {
      await vi.waitFor(() => expect(api.getInfo).toHaveBeenCalled());
      await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
      expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
      useAnnouncementSheetSlotStore.getState().release("onboarding");
      await expect.element(page.getByRole("dialog")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
  it("shows optional first-launch guidance and serializes other welcome dialogs", async () => {
    await render(<Harness />);
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect.element(page.getByText("Next welcome")).not.toBeInTheDocument();
    await expect.element(page.getByRole("dialog")).toHaveTextContent("It's optional");
    await observeCookieEvidence("startup-intro", {
      openSettingsCalls: api.openSettings.mock.calls.length,
      acknowledgment: localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY),
    });
    for (const browser of ["Chrome", "Safari", "Edge", "Helium", "Aside", "Arc", "Dia"])
      await expect.element(page.getByRole("dialog")).toHaveTextContent(browser);
    await expect.element(page.getByRole("dialog")).toHaveTextContent("Saved logins");
    await expect
      .element(page.getByRole("button", { name: "Open System Settings" }))
      .not.toBeInTheDocument();
    expect(api.openSettings).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Safari access setup" }).click();
    await expect.element(page.getByRole("dialog")).toHaveTextContent("broad macOS permission");
    await observeCookieEvidence("manual-safari-setup", {
      openSettingsCalls: api.openSettings.mock.calls.length,
      acknowledgment: localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY),
    });
    await expect.element(page.getByText("Next welcome")).not.toBeInTheDocument();
    await expect.element(page.getByRole("dialog")).toHaveTextContent("Synara (Dev)");
    await expect
      .element(page.getByRole("button", { name: "Show app in Finder" }))
      .toHaveAttribute("title", "/Applications/Synara (Dev).app");
    expect(api.openSettings).not.toHaveBeenCalled();
    expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
  });

  it("persists browser guidance acknowledgment across remounts and allows Safari revisits", async () => {
    const mounted = await render(<Harness />);
    await page.getByRole("button", { name: "Got it", exact: true }).click();
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    expect(JSON.parse(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)!)).toBe("later");
    await mounted.unmount();
    await render(<Harness />);
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Safari import setup" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
  });

  it("still honors the legacy continued decision", async () => {
    localStorage.setItem(SAFARI_ACCESS_STORAGE_KEY, JSON.stringify("continued"));
    await render(<Harness />);
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  });

  it("opening Settings is not permission approval or an acknowledged intro", async () => {
    await render(<Harness />);
    await page.getByRole("button", { name: "Safari access setup" }).click();
    await page.getByRole("button", { name: "Open System Settings" }).click();
    await expect.element(page.getByRole("status")).toHaveTextContent("quit and reopen");
    expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
    await page.getByRole("button", { name: "Show app in Finder" }).click();
    expect(api.revealApp).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("status")).toHaveTextContent("selected in Finder");
  });

  it.each([false, "reject"])(
    "leaves manual settings and skip available after open failure %s",
    async (failure) => {
      if (failure === false) api.openSettings.mockResolvedValueOnce(false);
      else api.openSettings.mockRejectedValueOnce(new Error("private failure"));
      await render(<Harness />);
      await page.getByRole("button", { name: "Safari access setup" }).click();
      await page.getByRole("button", { name: "Open System Settings" }).click();
      await expect.element(page.getByRole("status")).toHaveTextContent("Couldn't open");
      await expect.element(page.getByRole("status")).not.toHaveTextContent("private failure");
      await page.getByRole("button", { name: "Not now" }).click();
      await expect.element(page.getByText("Next welcome")).toBeVisible();
    },
  );

  it.each(["web", "unavailable"])("does not show macOS onboarding on %s", async (mode) => {
    if (mode === "web") delete window.desktopBridge;
    else
      window.desktopBridge = {
        safariAccess: {
          ...api,
          getInfo:
            mode === "unsupported"
              ? async () => ({ supported: false })
              : async () => {
                  throw new Error("unavailable");
                },
        },
      } as unknown as DesktopBridge;
    await render(<Harness />);
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Safari import setup" }))
      .not.toBeInTheDocument();
    expect(localStorage.getItem(SAFARI_ACCESS_STORAGE_KEY)).toBeNull();
  });

  it("does not reopen for a late Settings response after skipping", async () => {
    let resolve!: (opened: boolean) => void;
    api.openSettings.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await render(<Harness />);
    await page.getByRole("button", { name: "Safari access setup" }).click();
    await page.getByRole("button", { name: "Open System Settings" }).click();
    await page.getByRole("button", { name: "Not now" }).click();
    resolve(true);
    await expect.element(page.getByText("Next welcome")).toBeVisible();
    await expect.element(page.getByRole("status")).not.toBeInTheDocument();
  });
});

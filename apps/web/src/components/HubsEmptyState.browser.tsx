import "../index.css";

import type { CSSProperties } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { HubsEmptyState } from "./HubsEmptyState";
import { Sidebar, SidebarInstanceProvider, SidebarProvider, SidebarRail } from "./ui/sidebar";

vi.mock("~/env", () => ({ isElectron: true }));

const RESIZABLE = { minWidth: 200 };

// The `_chat.tsx` shell around a route: the left panel, the detached content-seam rail, and
// the route column.
function renderRailShell() {
  return render(
    <SidebarProvider
      defaultOpen
      data-sidebar-side="left"
      data-sidebar-layout="rail"
      style={{ "--app-top-strip-height": "44px" } as CSSProperties}
    >
      <Sidebar side="left" collapsible="offcanvas" resizable={RESIZABLE}>
        <span>Hubs</span>
      </Sidebar>
      <div className="relative flex h-svh min-h-0 min-w-0 flex-1">
        <SidebarInstanceProvider side="left" resizable={RESIZABLE}>
          <SidebarRail placement="content-seam" />
        </SidebarInstanceProvider>
        <HubsEmptyState />
      </div>
    </SidebarProvider>,
  );
}

const seamStyle = (container: HTMLElement) =>
  getComputedStyle(container.querySelector<HTMLElement>(".chat-content-card")!, "::after");

describe("Hubs empty state", () => {
  beforeEach(async () => {
    await page.viewport(1280, 800);
  });

  it("renders on the route card with the shared header, so the panel seam is drawn", async () => {
    const screen = await renderRailShell();
    try {
      const card = screen.container.querySelector<HTMLElement>(".chat-content-card");
      expect(card).not.toBeNull();
      expect(card!.querySelector(".app-top-bar")).not.toBeNull();
      expect(card!.querySelector("main")!.textContent).toContain("No hubs yet");
      expect(seamStyle(screen.container).content).not.toBe("none");
      expect(seamStyle(screen.container).borderLeftWidth).not.toBe("0px");
    } finally {
      await screen.unmount();
    }
  });
});

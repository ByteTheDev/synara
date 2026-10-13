import "../index.css";

import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { SearchIcon, BellIcon } from "~/lib/icons";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarThreadSectionPicker } from "./SidebarThreadSectionPicker";
import type { SidebarThreadSection } from "./Sidebar.uiState";

const protocol = () => cdp() as {
  send(method: "Emulation.setEmulatedMedia", params: { features: { name: string; value: string }[] }): Promise<void>;
};

function Harness({ width = 256 }: { width?: number }) {
  const [value, setValue] = useState<SidebarThreadSection | null>(null);
  const [unread, setUnread] = useState(false);
  return (
    <div style={{ width }}>
      <SidebarThreadSectionPicker value={value} attention={{ projects: false, chats: unread }} onValueChange={setValue}>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <SidebarIconButton icon={SearchIcon} label="Search" size="header" />
          <SidebarIconButton icon={BellIcon} label="Activity" size="header" />
        </div>
      </SidebarThreadSectionPicker>
      <button onClick={() => setUnread((current) => !current)}>Toggle unread</button>
    </div>
  );
}

afterEach(async () => {
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("--app-font-size-ui-sm");
  await protocol().send("Emulation.setEmulatedMedia", { features: [] });
});

it.each([
  { theme: "light", width: 256, fontSize: 12 },
  { theme: "dark", width: 256, fontSize: 12 },
  { theme: "light", width: 224, fontSize: 12 },
  { theme: "dark", width: 256, fontSize: 20 },
])("contains selection and keeps labels stable ($theme, $width, $fontSize)", async ({ theme, width, fontSize }) => {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.setProperty("--app-font-size-ui-sm", `${fontSize}px`);
  const screen = await render(<Harness width={width} />);
  try {
    const projects = page.getByRole("radio", { name: "Projects", exact: true });
    const chats = page.getByRole("radio", { name: /^Chats/ });
    const label = chats.element().querySelector<HTMLElement>('[data-slot="segmented-label"]')!;
    const labelLeft = label.getBoundingClientRect().left;
    await projects.click();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(chats).toHaveAttribute("aria-checked", "true");
    expect(document.activeElement).toBe(chats.element());
    await page.getByRole("button", { name: "Toggle unread" }).click();
    await expect.element(chats).toHaveAttribute("aria-label", "Chats — needs attention");
    expect(label.getBoundingClientRect().left).toBeCloseTo(labelLeft, 1);
    const track = screen.container.querySelector<HTMLElement>('[role="radiogroup"]')!;
    const thumb = track.querySelector<HTMLElement>('[data-slot="segmented-thumb"]')!;
    await Promise.all(thumb.getAnimations().map((animation) => animation.finished));
    const bounds = track.getBoundingClientRect();
    const selected = thumb.getBoundingClientRect();
    expect(selected.left).toBeGreaterThanOrEqual(bounds.left);
    expect(selected.right).toBeLessThanOrEqual(bounds.right);
    expect(selected.top).toBeGreaterThanOrEqual(bounds.top);
    expect(selected.bottom).toBeLessThanOrEqual(bounds.bottom);
    expect(projects.element().getBoundingClientRect().width).toBeCloseTo(chats.element().getBoundingClientRect().width, 1);
    expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
    const search = page.getByRole("button", { name: "Search", exact: true }).element().getBoundingClientRect();
    const toolbar = screen.container.querySelector<HTMLElement>('[data-slot="sidebar-list-toolbar"]')!;
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth);
    expect(search.left >= bounds.right || search.top >= bounds.bottom).toBe(true);
  } finally {
    await screen.unmount();
  }
});

it("keeps selection visible without animation in reduced motion and forced colors", async () => {
  await protocol().send("Emulation.setEmulatedMedia", { features: [
    { name: "prefers-reduced-motion", value: "reduce" },
    { name: "forced-colors", value: "active" },
  ] });
  const screen = await render(<Harness />);
  try {
    const projects = page.getByRole("radio", { name: "Projects", exact: true });
    const chats = page.getByRole("radio", { name: "Chats", exact: true });
    await expect.element(projects).toHaveAttribute("tabindex", "0");
    expect(screen.container.querySelector('[data-slot="segmented-thumb"]')).toBeNull();
    await projects.click();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(chats).toHaveAttribute("aria-checked", "true");
    const thumb = screen.container.querySelector<HTMLElement>('[data-slot="segmented-thumb"]')!;
    expect(thumb.getAnimations()).toHaveLength(0);
    expect(getComputedStyle(chats.element()).outlineStyle).toBe("solid");
    expect(getComputedStyle(chats.element()).outlineWidth).toBe("2px");
  } finally {
    await screen.unmount();
  }
});

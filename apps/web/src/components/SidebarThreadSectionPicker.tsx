// FILE: SidebarThreadSectionPicker.tsx
// Purpose: Compact, pinned list switching with off-screen attention and adjacent utilities.
// Layer: Sidebar presentation; selection and canonical activity state belong to Sidebar.

import type { ReactNode } from "react";
import { SegmentedPicker } from "./SegmentedPicker";
import type { SidebarThreadSection } from "./Sidebar.uiState";

export function SidebarThreadSectionPicker({
  value,
  attention,
  onValueChange,
  children,
}: {
  value: SidebarThreadSection | null;
  attention: Readonly<Record<SidebarThreadSection, boolean>>;
  onValueChange: (value: SidebarThreadSection) => void;
  children?: ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-0.5 pb-2"
      data-slot="sidebar-list-toolbar"
    >
      <SegmentedPicker
        value={value}
        variant="inset"
        ariaLabel="Thread lists"
        className="flex-[1_1_13em] text-ui-sm"
        options={(["projects", "chats"] as const).map((section) => {
          const label = section === "projects" ? "Projects" : "Chats";
          const description = attention[section] ? `${label} — needs attention` : label;
          return {
            value: section,
            label,
            ariaLabel: description,
            title: description,
            badge: attention[section] ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full bg-[var(--color-text-accent)] forced-colors:bg-[Highlight]"
              />
            ) : null,
          };
        })}
        onValueChange={onValueChange}
      />
      {children}
    </div>
  );
}

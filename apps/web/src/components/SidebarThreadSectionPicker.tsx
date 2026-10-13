// FILE: SidebarThreadSectionPicker.tsx
// Purpose: Persistent access to Projects and Chats, including off-screen attention.
// Layer: Sidebar presentation; selection and canonical activity state belong to Sidebar.

import { SegmentedPicker } from "./SegmentedPicker";
import type { SidebarThreadSection } from "./Sidebar.uiState";

export function SidebarThreadSectionPicker({
  value,
  attention,
  onValueChange,
}: {
  value: SidebarThreadSection | null;
  attention: Readonly<Record<SidebarThreadSection, boolean>>;
  onValueChange: (value: SidebarThreadSection) => void;
}) {
  return (
    <SegmentedPicker
      value={value}
      ariaLabel="Thread lists"
      className="mx-2.5 mb-2 mt-1"
      options={(["projects", "chats"] as const).map((section) => {
        const label = section === "projects" ? "Projects" : "Chats";
        const description = attention[section] ? `${label} — needs attention` : label;
        return {
          value: section,
          label,
          ariaLabel: description,
          title: description,
          icon: attention[section] ? (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-[var(--color-text-accent)]"
            />
          ) : null,
        };
      })}
      onValueChange={onValueChange}
    />
  );
}

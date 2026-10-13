from pathlib import Path
import sys

root = Path('.')
def replace(path, old, new):
    file = root / path
    source = file.read_text()
    assert source.count(old) == 1, (path, source.count(old))
    file.write_text(source.replace(old, new))

p = 'apps/web/src/components/SegmentedPicker.tsx'
replace(p, '  readonly icon?: ReactNode;', '  readonly icon?: ReactNode;\n  /** A non-interactive trailing status marker; kept outside the centred label. */\n  readonly badge?: ReactNode;')
replace(p, '  className,\n}: {', '  className,\n  variant = "raised",\n}: {')
replace(p, '  className?: string;\n}) {', '  className?: string;\n  /** Inset keeps selection inside the track for compact sidebar toolbars. */\n  variant?: "raised" | "inset";\n}) {')
replace(p, '  const thumb = activeIndex >= 0 ? thumbGeometry(activeIndex, options.length) : null;', '''  const inset = variant === "inset";
  const thumb =
    activeIndex < 0
      ? null
      : inset
        ? {
            left: "0.125rem",
            width: `calc((100% - 0.25rem) / ${options.length})`,
            transform: `translateX(${activeIndex * 100}%)`,
          }
        : thumbGeometry(activeIndex, options.length);''')
replace(p, '<div className={cn("px-1", className)}>', '<div className={cn(inset ? "min-w-0" : "px-1", className)}>')
replace(p, '        className="sidebar-segmented-picker relative isolate inline-flex w-full rounded-lg p-0.5"', '''        data-variant={variant}
        className={cn(
          "relative isolate inline-flex w-full rounded-lg p-0.5",
          inset ? "sidebar-segmented-picker-inset" : "sidebar-segmented-picker",
        )}''')
replace(p, '            className="sidebar-segmented-thumb pointer-events-none absolute -inset-y-[1.5px] z-0 rounded-md transition-[left,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"', '''            data-slot="segmented-thumb"
            className={cn(
              "pointer-events-none absolute z-0 rounded-md motion-reduce:transition-none",
              inset
                ? "sidebar-segmented-thumb-inset inset-y-0.5 transition-transform duration-200 ease-out"
                : "sidebar-segmented-thumb -inset-y-[1.5px] transition-[left,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
            )}''')
replace(p, '                active\n                  ? "text-[var(--color-text-foreground)]"', '''                inset && "min-h-7 px-4 py-1 focus-visible:ring-2 motion-reduce:transition-none",
                active
                  ? "text-[var(--color-text-foreground)]"''')
replace(p, '${active ? labelShift(index, options.length) : "0px"}', '${active && !inset ? labelShift(index, options.length) : "0px"}')
replace(p, '                <span className="truncate">{option.label}</span>', '                <span data-slot="segmented-label" className="truncate">{option.label}</span>')
replace(p, '              </span>\n            </button>', '''              </span>
              {option.badge ? (
                <span className="pointer-events-none absolute end-1.5 top-1/2 flex -translate-y-1/2 items-center">
                  {option.badge}
                </span>
              ) : null}
            </button>''')
p = 'apps/web/src/components/SidebarThreadSectionPicker.tsx'
(root / p).write_text('''// FILE: SidebarThreadSectionPicker.tsx
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
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-0.5 pb-2" data-slot="sidebar-list-toolbar">
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
''')
p = 'apps/web/src/components/Sidebar.tsx'
s = (root / p).read_text()
start = s.index('                <div className="ml-auto flex items-center gap-1.5">', s.index('      {/* Phones show the sidebar'))
end = s.index('                </div>', start) + len('                </div>')
actions = s[start:end]
assert actions.count('betaBadge') == 1
extracted = actions.replace('className="ml-auto flex items-center gap-1.5"', 'className="ml-auto flex shrink-0 items-center gap-1"').replace('{betaBadge}', '{!showThreadSectionPicker ? betaBadge : null}')
s = s[:start] + '                {showThreadSectionPicker ? (\n                  <div className="ml-auto">{betaBadge}</div>\n                ) : sidebarHeaderActions}' + s[end:]
marker = "  // Home and Spaces switch the panel; route items navigate (prewarm included). The store's"
assert s.count(marker) == 1
s = s.replace(marker, '  const sidebarHeaderActions = (\n' + extracted + '\n  );\n\n' + marker)
a = s.index('              {showThreadSectionPicker ? (\n                <SidebarThreadSectionPicker')
b = s.index('              ) : null}', a)
segment = s[a:b]
assert segment.count('                />') == 1
s = s[:a] + segment.replace('                />', '                >\n                  {sidebarHeaderActions}\n                </SidebarThreadSectionPicker>') + s[b:]
(root / p).write_text(s)
p = 'apps/web/src/index.css'
replace(p, '/* Frosted translucent shell shared by floating menus & pickers (dropdown menus,', '''/* Compact sidebar toolbar variant. Unlike the raised settings picker, the selected
   segment stays inside a quiet track and neither labels nor badges shift on selection. */
.sidebar-segmented-picker-inset {
  background: color-mix(in oklab, var(--foreground) 6%, transparent);
}

.sidebar-segmented-thumb-inset {
  background: var(--background);
  border: 1px solid color-mix(in oklab, var(--foreground) 6%, transparent);
  box-shadow: 0 1px 2px rgb(0 0 0 / 8%);
}

.dark .sidebar-segmented-thumb-inset {
  background: color-mix(in oklab, var(--foreground) 12%, var(--background));
  border-color: color-mix(in oklab, var(--foreground) 8%, transparent);
  box-shadow: 0 1px 2px rgb(0 0 0 / 16%);
}

@media (prefers-contrast: more) {
  .sidebar-segmented-picker-inset {
    outline: 1px solid var(--muted-foreground);
  }

  .sidebar-segmented-thumb-inset {
    border-color: var(--foreground);
  }
}

@media (forced-colors: active) {
  .sidebar-segmented-picker-inset {
    outline: 1px solid ButtonText;
  }

  .sidebar-segmented-thumb-inset {
    background: Canvas;
    border-color: Highlight;
    box-shadow: none;
  }

  .sidebar-segmented-picker-inset [aria-checked="true"] {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }
}

/* Frosted translucent shell shared by floating menus & pickers (dropdown menus,''')

// FILE: SegmentedPicker.tsx
// Purpose: The raised-thumb segmented control (a recessed track with a sliding selected chip that
//          hangs past the track at either end), as a radio group with arrow-key selection.
//          Styling lives in index.css (`.sidebar-segmented-picker`, `.sidebar-segmented-thumb`).
// Layer: Shared presentation
// Exports: SegmentedPicker, SegmentedPickerOption

import type { ReactNode } from "react";

import { useRadioGroupKeyboardNav } from "~/hooks/useRadioGroupKeyboardNav";
import { cn } from "~/lib/utils";

export interface SegmentedPickerOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly ariaLabel?: string;
  readonly icon?: ReactNode;
  /** A non-interactive trailing status marker; kept outside the centred label. */
  readonly badge?: ReactNode;
  readonly disabled?: boolean;
  readonly title?: string;
}

/** How far the selected chip hangs past the track at either end. */
const THUMB_OVERHANG = "5px";

function thumbGeometry(index: number, count: number): { left: string; width: string } {
  const cell = `(100% - 0.25rem) / ${count}`;
  const left = `calc(0.125rem + ${index} * (${cell}))`;
  const edgeWidth = `calc(${cell} + 0.125rem + 1px + ${THUMB_OVERHANG})`;
  if (index === 0) return { left: `calc(-1px - ${THUMB_OVERHANG})`, width: edgeWidth };
  return index === count - 1 ? { left, width: edgeWidth } : { left, width: `calc(${cell})` };
}

/** The end chips are wider than their cell, so their labels shift half the extra outward to
 *  stay centred on the chip rather than the cell. */
function labelShift(index: number, count: number): string {
  const extra = `(0.125rem + 1px + ${THUMB_OVERHANG}) / 2`;
  if (index === 0) return `calc(-1 * ${extra})`;
  return index === count - 1 ? `calc(${extra})` : "0px";
}

export function SegmentedPicker<T extends string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  disabled: disabledProp,
  className,
  variant = "raised",
}: {
  value: T | null;
  options: ReadonlyArray<SegmentedPickerOption<T>>;
  onValueChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  /** Inset keeps selection inside the track for compact sidebar toolbars. */
  variant?: "raised" | "inset";
}) {
  const disabled = disabledProp ?? false;
  const radioItemProps = useRadioGroupKeyboardNav({
    values: options.filter((option) => !option.disabled).map((option) => option.value),
    value,
    onValueChange,
  });
  const activeIndex = options.findIndex((option) => option.value === value);
  const inset = variant === "inset";
  const thumb =
    activeIndex < 0
      ? null
      : inset
        ? {
            left: "0.125rem",
            width: `calc((100% - 0.25rem) / ${options.length})`,
            transform: `translateX(${activeIndex * 100}%)`,
          }
        : thumbGeometry(activeIndex, options.length);

  return (
    <div className={cn(inset ? "min-w-0" : "px-1", className)}>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        data-variant={variant}
        className={cn(
          "relative isolate inline-flex w-full rounded-lg p-0.5",
          inset ? "sidebar-segmented-picker-inset" : "sidebar-segmented-picker",
        )}
      >
        {thumb ? (
          <div
            aria-hidden
            data-slot="segmented-thumb"
            className={cn(
              "pointer-events-none absolute z-0 rounded-md motion-reduce:transition-none",
              inset
                ? "sidebar-segmented-thumb-inset inset-y-0.5 transition-transform duration-200 ease-out"
                : "sidebar-segmented-thumb -inset-y-[1.5px] transition-[left,width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
            )}
            style={thumb}
          />
        ) : null}
        {options.map((option, index) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={option.ariaLabel}
              disabled={disabled || option.disabled}
              title={option.title}
              className={cn(
                "relative z-10 flex min-w-0 flex-1 items-center justify-center rounded-md px-2.5 py-1 text-ui-sm font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
                inset && "min-h-7 px-4 py-1 focus-visible:ring-2 motion-reduce:transition-none",
                active
                  ? "text-[var(--color-text-foreground)]"
                  : "text-[var(--color-text-foreground-secondary)] hover:text-[var(--color-text-foreground)]",
              )}
              onClick={() => onValueChange(option.value)}
              {...radioItemProps(option.value)}
            >
              <span
                className="flex min-w-0 items-center gap-1.5 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
                style={{
                  transform: `translateX(${active && !inset ? labelShift(index, options.length) : "0px"})`,
                }}
              >
                {option.icon}
                <span data-slot="segmented-label" className="truncate">
                  {option.label}
                </span>
              </span>
              {option.badge ? (
                <span className="pointer-events-none absolute end-1.5 top-1/2 flex -translate-y-1/2 items-center">
                  {option.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

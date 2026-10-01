"use client";

/**
 * BadaBhai Design System — Chip (selectable / removable pill).
 *
 * Client primitive: defines an inline remove handler. Style via `.bb-*` + tokens.
 * Prop contract mirrors docs/design/.../components/display/Chip.d.ts.
 */
import type { ButtonHTMLAttributes, MouseEvent } from "react";
import { Icon, type IconName } from "@badabhai/icons";

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onRemove"> {
  /** Selected (brand) state. */
  selected?: boolean;
  /** Leading glyph. */
  icon?: IconName;
  /** When provided, shows an ✕ and calls this on click. */
  onRemove?: (e: MouseEvent) => void;
}

export function Chip({ selected = false, icon, onRemove, className = "", children, ...rest }: ChipProps) {
  const cls = ["bb-chip", selected ? "bb-chip--selected" : "", className].filter(Boolean).join(" ");

  return (
    <button type="button" className={cls} aria-pressed={selected} {...rest}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
      {onRemove && (
        <span
          className="bb-chip__remove"
          role="button"
          aria-label="Remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(e);
          }}
        >
          <Icon name="x" />
        </span>
      )}
    </button>
  );
}

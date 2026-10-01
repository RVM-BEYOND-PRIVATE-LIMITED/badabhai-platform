"use client";

/**
 * BadaBhai Design System — IconButton: the ONE icon-only control (payer-web).
 *
 * Implements the shared icon-only-control contract (`IconOnlyControlProps`, @badabhai/icons):
 *   - `label` is REQUIRED and is the control's only accessible name (`aria-label`). `aria-label`,
 *     `aria-labelledby` and `title` are not accepted, so a caller can neither name it twice nor
 *     fall back to a title-only hint that keyboard and touch users never see.
 *   - The label shows as a VISIBLE tooltip on pointer hover and on keyboard focus
 *     (`:focus-visible`), styled in ds-components.css (`.bb-iconbtn__tip`). It is hoverable, and
 *     Escape dismisses it without moving focus (WCAG 1.4.13). The tooltip text is aria-hidden: it
 *     repeats the name the button already has.
 *   - A native `<button>`: Tab, Enter and Space need no code.
 *   - ≥44×44 hit area on a phone or coarse pointer, `sm` included (the CSS grows the hit area,
 *     not the drawn control).
 *
 * A CLIENT component because of the Escape handler; everything else is CSS. Colour follows the
 * brand rule: structural Shift Blue at rest, Safety Yellow fill when pressed/expanded (an active
 * utility), the 40% step when disabled.
 */
import type { ButtonHTMLAttributes } from "react";
import {
  Icon,
  dismissTooltipOnEscape,
  restoreTooltip,
  warnIfUnlabelled,
  type IconOnlyControlProps,
} from "@badabhai/icons";

export interface IconButtonProps
  extends
    Omit<
      ButtonHTMLAttributes<HTMLButtonElement>,
      "children" | "aria-label" | "aria-labelledby" | "title"
    >,
    IconOnlyControlProps {
  /** @default 'ghost' */
  variant?: "ghost" | "solid" | "outline";
  /** @default 'md' */
  size?: "sm" | "md" | "lg";
}

export function IconButton({
  icon,
  label,
  tooltipPlacement = "top",
  variant = "ghost",
  size = "md",
  className = "",
  type = "button",
  onKeyDown,
  onBlur,
  onMouseLeave,
  ...rest
}: IconButtonProps) {
  warnIfUnlabelled(label, "IconButton");
  const cls = [
    "bb-iconbtn",
    variant !== "ghost" ? `bb-iconbtn--${variant}` : "",
    size !== "md" ? `bb-iconbtn--${size}` : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...rest}
      /* After the spread: the contract's name, class and type cannot be overridden at runtime. */
      type={type}
      className={cls}
      aria-label={label}
      onKeyDown={(e) => {
        dismissTooltipOnEscape(e.currentTarget, e.key);
        onKeyDown?.(e);
      }}
      onBlur={(e) => {
        restoreTooltip(e.currentTarget);
        onBlur?.(e);
      }}
      onMouseLeave={(e) => {
        restoreTooltip(e.currentTarget);
        onMouseLeave?.(e);
      }}
    >
      <Icon name={icon} />
      <span className={`bb-iconbtn__tip bb-iconbtn__tip--${tooltipPlacement}`} aria-hidden="true">
        {label}
      </span>
    </button>
  );
}

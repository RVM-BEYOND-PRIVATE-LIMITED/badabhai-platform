"use client";

/**
 * IconButton — the ONE icon-only control in the admin portal.
 *
 * Same contract as payer-web's DS IconButton (`IconOnlyControlProps`, @badabhai/icons); only the
 * class vocabulary differs (`.iconbtn*` here, in globals.css):
 *   - `label` is REQUIRED and is the control's only accessible name (`aria-label`). `aria-label`,
 *     `aria-labelledby` and `title` are not accepted props.
 *   - The label shows as a VISIBLE tooltip on pointer hover and on keyboard focus; hoverable, and
 *     Escape dismisses it without moving focus (WCAG 1.4.13). The tooltip text is aria-hidden —
 *     it repeats the name the button already has.
 *   - A native `<button>`, so Tab / Enter / Space work with no extra code.
 *   - ≥44×44 hit area on a phone or coarse pointer, `sm` included.
 *
 * A client component for the Escape handler only. Escape is NOT swallowed: the shell's drawer,
 * which also closes on Escape, still does.
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
  /** `outline` draws the hairline border the console's chrome controls use. @default 'ghost' */
  variant?: "ghost" | "outline";
  /** @default 'md' */
  size?: "sm" | "md";
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
    "iconbtn",
    variant !== "ghost" ? `iconbtn--${variant}` : "",
    size !== "md" ? `iconbtn--${size}` : "",
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
      <span className={`iconbtn__tip iconbtn__tip--${tooltipPlacement}`} aria-hidden="true">
        {label}
      </span>
    </button>
  );
}

"use client";

/**
 * BadaBhai Design System — Toast (dark ink feedback surface).
 *
 * Client primitive (optional dismiss handler). Presentational only — the caller owns
 * when to show/hide it and supplies neutral, no-oracle copy. Prop contract mirrors
 * docs/design/.../components/feedback/Toast.d.ts.
 *
 * A toast on its own is a polite status (`role="status"`). Inside the portal's ToastProvider it
 * renders with `live={false}`: the provider's single region does the announcing, once (#2583).
 */
import type { HTMLAttributes, ReactNode, Ref } from "react";
import { ACTION_ICON, Icon, type IconName } from "@badabhai/icons";
import { IconButtonBase } from "@badabhai/icons/button";

const DEFAULT_ICON: Record<NonNullable<ToastProps["tone"]>, IconName> = {
  success: "check-circle",
  danger: "warning-circle",
  brand: "sparkle",
  neutral: "info",
};

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** @default 'neutral' */
  tone?: "neutral" | "success" | "danger" | "brand";
  /** Override the default glyph for the tone. */
  icon?: IconName;
  /** Bold first line. */
  title?: ReactNode;
  /** Supporting message (children). */
  children?: ReactNode;
  /** Show a dismiss ✕. */
  onClose?: () => void;
  /**
   * Announce itself (`role="status"`). False inside a live region that already announces it —
   * the ToastProvider's stack — so it is read once, not twice. @default true
   */
  live?: boolean;
  ref?: Ref<HTMLDivElement>;
}

export function Toast({
  tone = "neutral",
  icon,
  title,
  children,
  onClose,
  live = true,
  className = "",
  ...rest
}: ToastProps) {
  const cls = ["bb-toast", tone !== "neutral" ? `bb-toast--${tone}` : "", className].filter(Boolean).join(" ");

  return (
    <div className={cls} role={live ? "status" : undefined} {...rest}>
      <Icon name={icon || DEFAULT_ICON[tone]} className="bb-toast__icon" />
      <div className="bb-toast__content">
        {title && <div className="bb-toast__title">{title}</div>}
        {children && <div className="bb-toast__msg">{children}</div>}
      </div>
      {/* The shared icon-only control in the toast's skin: "Dismiss" is its name and its visible
          tooltip, opening above and inward from the toast's end edge. */}
      {onClose && (
        <IconButtonBase
          classBase="bb-toast__close"
          icon={ACTION_ICON.dismiss}
          label="Dismiss"
          tooltipPlacement="top-end"
          onClick={onClose}
        />
      )}
    </div>
  );
}

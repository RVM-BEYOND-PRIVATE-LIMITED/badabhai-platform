"use client";

/**
 * BadaBhai Design System — Toast (dark ink feedback surface).
 *
 * Client primitive (optional dismiss handler). Presentational only — the caller owns
 * when to show/hide it and supplies neutral, no-oracle copy. Prop contract mirrors
 * docs/design/.../components/feedback/Toast.d.ts.
 */
import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "@badabhai/icons";

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
}

export function Toast({ tone = "neutral", icon, title, children, onClose, className = "", ...rest }: ToastProps) {
  const cls = ["bb-toast", tone !== "neutral" ? `bb-toast--${tone}` : "", className].filter(Boolean).join(" ");

  return (
    <div className={cls} role="status" {...rest}>
      <Icon name={icon || DEFAULT_ICON[tone]} className="bb-toast__icon" />
      <div className="bb-toast__content">
        {title && <div className="bb-toast__title">{title}</div>}
        {children && <div className="bb-toast__msg">{children}</div>}
      </div>
      {onClose && (
        <button className="bb-toast__close" aria-label="Dismiss" onClick={onClose}>
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}

/**
 * BadaBhai Design System — static FEEDBACK primitives (Tooltip, ProgressBar).
 *
 * SHARED (no "use client"): no hooks/handlers, CSS-only interaction (the tooltip
 * shows on `:hover`/`:focus-within`). Dialog + Toast are interactive and live in
 * ./dialog.tsx / ./toast.tsx as client primitives. Style via `.bb-*` + tokens only.
 * Prop contracts mirror docs/design/.../components/feedback/{Tooltip,ProgressBar}.d.ts.
 */
import type { HTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "@badabhai/icons";

/* ---------- Tooltip ---------- */
export interface TooltipProps {
  /** Tooltip text. */
  label: ReactNode;
  /** @default 'top' */
  placement?: "top" | "bottom";
  /** The trigger element. */
  children: ReactNode;
}

export function Tooltip({ label, placement = "top", children }: TooltipProps) {
  return (
    <span className="bb-tooltip-wrap" tabIndex={0}>
      {children}
      <span className={`bb-tooltip bb-tooltip--${placement}`} role="tooltip">
        {label}
      </span>
    </span>
  );
}

/* ---------- Inline notice ---------- */

const NOTICE_ICON: Record<NonNullable<InlineNoticeProps["tone"]>, IconName> = {
  danger: "warning-circle",
  warning: "warning",
  info: "info",
  success: "check-circle",
};

/**
 * The ONE inline message surface for a form- or panel-level outcome: a calm tinted strip with a
 * solid glyph, sentence-case copy and no saturated fill. It is presentational (never a live
 * region of its own) so a caller may place it inside the portal's existing polite region without
 * the message being announced twice. Field-level refusals use `FieldFeedback` instead.
 */
export interface InlineNoticeProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  /** Semantic tone. @default 'info' */
  tone?: "danger" | "warning" | "info" | "success";
  /** Bold first line (optional). */
  title?: ReactNode;
  /** The message itself. */
  children?: ReactNode;
  /** Override the tone's glyph. */
  icon?: IconName;
  /** An optional inline action (e.g. Retry / View). */
  action?: ReactNode;
}

export function InlineNotice({
  tone = "info",
  title,
  children,
  icon,
  action,
  className = "",
  ...rest
}: InlineNoticeProps) {
  const cls = ["bb-inline-notice", `bb-inline-notice--${tone}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} {...rest}>
      <Icon name={icon ?? NOTICE_ICON[tone]} className="bb-inline-notice__icon" />
      <div className="bb-inline-notice__text">
        {title != null && <p className="bb-inline-notice__title">{title}</p>}
        {children != null && <p className="bb-inline-notice__msg">{children}</p>}
      </div>
      {action != null && <div className="bb-inline-notice__action">{action}</div>}
    </div>
  );
}

/* ---------- ProgressBar ---------- */
export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  /** 0–100. */
  value?: number;
  /** Optional label above the track. */
  label?: ReactNode;
  /** Show the % on the right. */
  showValue?: boolean;
  /** @default 'brand' */
  tone?: "brand" | "success";
  /** Thicker track. */
  thick?: boolean;
}

export function ProgressBar({
  value = 0,
  label,
  showValue = false,
  tone = "brand",
  thick = false,
  className = "",
  ...rest
}: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const cls = [
    "bb-progress",
    tone !== "brand" ? `bb-progress--${tone}` : "",
    thick ? "bb-progress--thick" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} {...rest}>
      {(label || showValue) && (
        <div className="bb-progress__head">
          <span>{label}</span>
          {showValue && <span className="bb-progress__pct">{pct}%</span>}
        </div>
      )}
      <div className="bb-progress__track">
        <div
          className="bb-progress__fill"
          style={{ width: `${pct}%` }}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        />
      </div>
    </div>
  );
}

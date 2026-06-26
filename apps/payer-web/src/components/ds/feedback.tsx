/**
 * BadaBhai Design System — static FEEDBACK primitives (Tooltip, ProgressBar).
 *
 * SHARED (no "use client"): no hooks/handlers, CSS-only interaction (the tooltip
 * shows on `:hover`/`:focus-within`). Dialog + Toast are interactive and live in
 * ./dialog.tsx / ./toast.tsx as client primitives. Style via `.bb-*` + tokens only.
 * Prop contracts mirror docs/design/.../components/feedback/{Tooltip,ProgressBar}.d.ts.
 */
import type { HTMLAttributes, ReactNode } from "react";

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

/**
 * BadaBhai Design System — BadaBhaiLogo (brand mark + Baloo 2 wordmark).
 *
 * SHARED (no "use client"): pure SVG + text, no hooks/handlers. The mark colors
 * resolve from design-system tokens via inline `style` (no raw hex), so the lockup
 * stays on-brand under both themes. Prop contract mirrors
 * docs/design/.../components/brand/BadaBhaiLogo.d.ts.
 */
import type { HTMLAttributes } from "react";

export interface BadaBhaiLogoProps extends HTMLAttributes<HTMLSpanElement> {
  /** @default 'full' */
  variant?: "full" | "mark" | "wordmark";
  /** Surface it sits on — flips wordmark color. @default 'paper' */
  theme?: "paper" | "ink";
  /** Mark size in px; wordmark scales from it. @default 32 */
  size?: number;
}

export function BadaBhaiLogo({
  variant = "full",
  theme = "paper",
  size = 32,
  className = "",
  ...rest
}: BadaBhaiLogoProps) {
  const mark = (
    <svg viewBox="0 0 512 512" width={size} height={size} className="bb-logo__mark" aria-hidden="true">
      <rect width="512" height="512" rx="128" style={{ fill: "var(--brand)" }} />
      <path
        d="M150 124h212a40 40 0 0 1 40 40v132a40 40 0 0 1-40 40H252l-78 62a12 12 0 0 1-19.4-9.4V336h-4.6a40 40 0 0 1-40-40V164a40 40 0 0 1 40-40Z"
        style={{ fill: "var(--paper-0)" }}
      />
      <path
        d="M196 268l60-58 60 58"
        style={{ stroke: "var(--success)" }}
        strokeWidth={32}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );

  return (
    <span
      className={["bb-logo", `bb-logo--${theme}`, className].filter(Boolean).join(" ")}
      role="img"
      aria-label="BadaBhai"
      {...rest}
    >
      {variant !== "wordmark" && mark}
      {variant !== "mark" && (
        <span className="bb-logo__word" style={{ fontSize: Math.round(size * 0.92) }}>
          <span className="bb-logo__a">Bada</span>
          <span className="bb-logo__b">Bhai</span>
        </span>
      )}
    </span>
  );
}

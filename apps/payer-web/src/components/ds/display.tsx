/**
 * BadaBhai Design System — DISPLAY primitives (Card, Badge, StatTile, Avatar).
 *
 * SHARED (no "use client"): purely presentational, no hooks/handlers — safe to render
 * from server components (e.g. the dashboard StatTiles). Style via `.bb-*` classes +
 * tokens only. Prop contracts mirror docs/design/.../components/display/*.d.ts.
 * (Chip is interactive and lives in ./chip.tsx as a client primitive.)
 */
import type { ElementType, HTMLAttributes, ReactNode } from "react";

/* ---------- Card ---------- */
export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** @default 'default' */
  variant?: "default" | "raised" | "flat" | "outline" | "ink";
  /** @default 'md' */
  padding?: "none" | "sm" | "md" | "lg";
  /** Adds hover-lift + pointer for clickable cards. */
  interactive?: boolean;
  /** Element/tag to render. @default 'div' */
  as?: ElementType;
}

export function Card({
  variant = "default",
  padding = "md",
  interactive = false,
  as,
  className = "",
  children,
  ...rest
}: CardProps) {
  const Tag = as ?? "div";
  const cls = [
    "bb-card",
    variant !== "default" ? `bb-card--${variant}` : "",
    padding !== "md" ? `bb-card--pad-${padding}` : "",
    interactive ? "bb-card--interactive" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={cls} {...rest}>
      {children}
    </Tag>
  );
}

/* ---------- Badge ---------- */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  /** @default 'neutral' */
  tone?: "neutral" | "brand" | "success" | "danger" | "warning" | "info";
  /** @default 'soft' */
  variant?: "soft" | "solid" | "outline";
  /** Uppercase + wide tracking for status labels. */
  upper?: boolean;
  /** Phosphor glyph name (rendered filled), e.g. `'seal-check'`. */
  icon?: string;
}

export function Badge({
  tone = "neutral",
  variant = "soft",
  upper = false,
  icon,
  className = "",
  children,
  ...rest
}: BadgeProps) {
  const cls = [
    "bb-badge",
    `bb-badge--${tone}`,
    variant !== "soft" ? `bb-badge--${variant}` : "",
    upper ? "bb-badge--upper" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={cls} {...rest}>
      {icon && <i className={`ph-fill ph-${icon}`} aria-hidden="true" />}
      {children}
    </span>
  );
}

/* ---------- StatTile ---------- */
export interface StatTileProps extends HTMLAttributes<HTMLDivElement> {
  /** Metric name. */
  label: string;
  /** Big value — rendered in Roboto Mono (tabular). */
  value: ReactNode;
  /** Phosphor glyph in the corner. */
  icon?: string;
  /** Delta text, e.g. `'+12% this week'`. */
  delta?: ReactNode;
  /** @default 'up' */
  deltaDir?: "up" | "down" | "flat";
}

export function StatTile({
  label,
  value,
  icon,
  delta,
  deltaDir = "up",
  className = "",
  ...rest
}: StatTileProps) {
  const arrow = deltaDir === "up" ? "trend-up" : deltaDir === "down" ? "trend-down" : "minus";
  return (
    <div className={["bb-stat", className].filter(Boolean).join(" ")} {...rest}>
      <div className="bb-stat__head">
        <span className="bb-stat__label">{label}</span>
        {icon && (
          <span className="bb-stat__icon">
            <i className={`ph ph-${icon}`} aria-hidden="true" />
          </span>
        )}
      </div>
      <div className="bb-stat__value">{value}</div>
      {delta != null && (
        <div className={`bb-stat__delta bb-stat__delta--${deltaDir}`}>
          <i className={`ph-bold ph-${arrow}`} aria-hidden="true" />
          {delta}
        </div>
      )}
    </div>
  );
}

/* ---------- Avatar ---------- */
export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  /** Image URL; falls back to initials from `name`. */
  src?: string;
  /** Full name — drives the initials fallback and alt text. */
  name?: string;
  /** Pixel diameter. @default 44 */
  size?: number;
  /** Blur the photo (locked / pre-unlock candidate). */
  masked?: boolean;
  /** Show the verified seal overlay. */
  verified?: boolean;
  /** Use the brand gradient placeholder instead of grey. */
  brand?: boolean;
}

export function Avatar({
  src,
  name = "",
  size = 44,
  masked = false,
  verified = false,
  brand = false,
  className = "",
  ...rest
}: AvatarProps) {
  const initials = name
    .trim()
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const cls = [
    "bb-avatar",
    masked ? "bb-avatar--masked" : "",
    brand ? "bb-avatar--brand" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={cls}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
      {...rest}
    >
      {src ? (
        <img className="bb-avatar__img" src={src} alt={name} />
      ) : (
        <span className="bb-avatar__initials">{initials || "?"}</span>
      )}
      {verified && (
        <span className="bb-avatar__seal">
          <i className="ph-fill ph-seal-check" aria-hidden="true" />
        </span>
      )}
    </span>
  );
}

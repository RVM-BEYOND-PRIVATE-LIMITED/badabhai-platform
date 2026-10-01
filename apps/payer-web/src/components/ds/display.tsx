/**
 * BadaBhai Design System — DISPLAY primitives (Card, Badge, StatTile, Avatar).
 *
 * SHARED (no "use client"): purely presentational, no hooks/handlers — safe to render
 * from server components (e.g. the dashboard StatTiles). Style via `.bb-*` classes +
 * tokens only. Prop contracts mirror docs/design/.../components/display/*.d.ts.
 * (Chip is interactive and lives in ./chip.tsx as a client primitive.)
 */
import type { ElementType, HTMLAttributes, ReactNode } from "react";
import Link from "next/link";
import { Icon, type IconName } from "@badabhai/icons";

/* ---------- Whole-surface link (Card + StatTile) ---------- */
/**
 * The optional whole-surface link. `href` and `ariaLabel` travel TOGETHER: the stretched-link
 * overlay is an EMPTY `<a>` (it carries no text of its own), so an `href` without a name would
 * ship an unnamed link — screen readers announce it as the bare URL, or just "link" (WCAG 2.4.4
 * / 4.1.2). With no `href` there is no link to name, so an `ariaLabel` is refused rather than
 * silently dropped.
 */
type SurfaceLinkProps =
  | {
      /**
       * When set, the WHOLE surface becomes ONE accessible interactive link to `href` via the
       * stretched-link pattern (a single `<a>` that itself overlays the surface; the root becomes
       * `position:relative`). Backward-compatible: omit `href` and it renders EXACTLY as before
       * (no `<a>` is added). Any OTHER interactive child must sit above the overlay
       * (`position:relative; z-index:2`) so it stays clickable and there is never an `<a>` in `<a>`.
       */
      href: string;
      /**
       * The link's accessible name — REQUIRED with `href`. Name the destination/action, not just
       * the visible label (e.g. `"Credit balance 247 — open wallet"`).
       */
      ariaLabel: string;
    }
  | { href?: never; ariaLabel?: never };

/* ---------- Card ---------- */
interface CardOwnProps extends HTMLAttributes<HTMLElement> {
  /** @default 'default' */
  variant?: "default" | "raised" | "flat" | "outline" | "ink";
  /** @default 'md' */
  padding?: "none" | "sm" | "md" | "lg";
  /** Adds hover-lift + pointer for clickable cards. */
  interactive?: boolean;
  /** Element/tag to render. @default 'div' */
  as?: ElementType;
}
export type CardProps = CardOwnProps & SurfaceLinkProps;

export function Card({
  variant = "default",
  padding = "md",
  interactive = false,
  as,
  href,
  ariaLabel,
  className = "",
  children,
  ...rest
}: CardProps) {
  const Tag = as ?? "div";
  const isLink = href != null;
  const cls = [
    "bb-card",
    variant !== "default" ? `bb-card--${variant}` : "",
    padding !== "md" ? `bb-card--pad-${padding}` : "",
    interactive ? "bb-card--interactive" : "",
    isLink ? "bb-card--link" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Tag className={cls} {...rest}>
      {isLink && <Link className="bb-stretched-link" href={href} aria-label={ariaLabel} />}
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
  icon?: IconName;
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
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

/* ---------- StatTile ---------- */
interface StatTileOwnProps extends HTMLAttributes<HTMLDivElement> {
  /** Metric name. */
  label: string;
  /** Big value — rendered in Roboto Mono (tabular). */
  value: ReactNode;
  /** Phosphor glyph in the corner. */
  icon?: IconName;
  /** Delta text, e.g. `'+12% this week'`. */
  delta?: ReactNode;
  /** @default 'up' */
  deltaDir?: "up" | "down" | "flat";
  /**
   * A NEUTRAL supporting caption under the value (e.g. `'1 credit each'`, a unit price). This is
   * NOT a trend — it carries no arrow and no up/down/flat colour. Use it instead of overloading
   * `delta`/`deltaDir="flat"` for context that isn't a change over time.
   */
  caption?: ReactNode;
}
/** `href` + `ariaLabel` as for {@link CardProps} — the bare label+value is rarely a clear name. */
export type StatTileProps = StatTileOwnProps & SurfaceLinkProps;

export function StatTile({
  label,
  value,
  icon,
  delta,
  deltaDir = "up",
  caption,
  href,
  ariaLabel,
  className = "",
  ...rest
}: StatTileProps) {
  const arrow: IconName =
    deltaDir === "up" ? "trend-up" : deltaDir === "down" ? "trend-down" : "minus";
  const isLink = href != null;
  const cls = ["bb-stat", isLink ? "bb-stat--link" : "", className].filter(Boolean).join(" ");
  return (
    <div className={cls} {...rest}>
      {isLink && <Link className="bb-stretched-link" href={href} aria-label={ariaLabel} />}
      <div className="bb-stat__head">
        <span className="bb-stat__label">{label}</span>
        {icon && (
          <span className="bb-stat__icon">
            <Icon name={icon} />
          </span>
        )}
      </div>
      <div className="bb-stat__value">{value}</div>
      {caption != null && <div className="bb-stat__caption">{caption}</div>}
      {delta != null && (
        <div className={`bb-stat__delta bb-stat__delta--${deltaDir}`}>
          <Icon name={arrow} />
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
          <Icon name="seal-check" />
        </span>
      )}
    </span>
  );
}

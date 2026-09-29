/**
 * BadaBhai Design System — BadaBhaiLogo (the two-figure monogram + the BADABHAI logotype).
 *
 * SHARED (no "use client"): plain spans, no hooks/handlers. The lockup classes
 * (`.bb-lockup*`) live in the shared token package (@badabhai/design-tokens), which also
 * carries the Sept 2026 brand-kit images and draws them as CSS backgrounds — so payer-web and
 * admin-web show the same brand from one copy. The monogram's ivory figure needs a Shift Blue
 * tile on a light surface and sits straight on the band when `theme="ink"`; the logotype is
 * white on the band and Shift Blue on paper (and knocked out to white on an ink page). The
 * images are decorative — the root carries the accessible name.
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

export interface BadaBhaiLogoProps extends HTMLAttributes<HTMLSpanElement> {
  /** @default 'full' */
  variant?: "full" | "mark" | "wordmark";
  /** Surface it sits on — `ink` drops the tile and switches to the white logotype. @default 'paper' */
  theme?: "paper" | "ink";
  /** Mark (tile) size in px; the logotype height is derived from it. @default 32 */
  size?: number;
  /** Optional caption under the logotype (ignored for `variant="mark"`). */
  sub?: ReactNode;
}

export function BadaBhaiLogo({
  variant = "full",
  theme = "paper",
  size = 32,
  sub,
  className = "",
  style,
  ...rest
}: BadaBhaiLogoProps) {
  // The tile size feeds the token-package lockup rules through one custom property; the
  // logotype's height is derived from it there.
  const sizeVar = { "--bb-lockup-size": `${size}px` } as CSSProperties;

  const mark = (
    <span className="bb-lockup__tile" aria-hidden="true">
      <span className="bb-lockup__mark" />
    </span>
  );

  const word = <span className="bb-lockup__wordmark" aria-hidden="true" />;

  return (
    <span
      className={["bb-lockup", theme === "ink" ? "bb-lockup--on-ink" : "", className]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label="BadaBhai"
      style={{ ...sizeVar, ...style }}
      {...rest}
    >
      {variant !== "wordmark" && mark}
      {variant !== "mark" &&
        (sub != null ? (
          <span className="bb-lockup__text">
            {word}
            <span className="bb-lockup__sub">{sub}</span>
          </span>
        ) : (
          word
        ))}
    </span>
  );
}

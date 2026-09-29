/**
 * BadaBhai Design System — BadaBhaiLogo (the two-figure monogram + the BADABHAI logotype).
 *
 * SHARED (no "use client"): plain <img>s, no hooks/handlers. The lockup classes
 * (`.bb-lockup*`) live in the shared token package (@badabhai/design-tokens), so payer-web
 * and admin-web draw the same brand. Both images come from the Sept 2026 brand kit
 * (public/brand/): the monogram's ivory figure needs a Shift Blue tile on a light surface and
 * sits straight on the band when `theme="ink"`; the logotype is white on the band and Shift
 * Blue on paper. The images are decorative — the root carries the accessible name.
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

/** The two-figure monogram (public/brand/). */
const MARK_SRC = "/brand/badabhai-mark.png";
/** The official logotype, one file per surface. Intrinsic size 716×96. */
const WORDMARK_SRC = { paper: "/brand/badabhai-wordmark-navy.png", ink: "/brand/badabhai-wordmark.png" };
const WORDMARK_W = 716;
const WORDMARK_H = 96;

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
    <span className="bb-lockup__tile">
      <img
        className="bb-lockup__mark"
        src={MARK_SRC}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
      />
    </span>
  );

  const word = (
    <img
      className="bb-lockup__wordmark"
      src={WORDMARK_SRC[theme]}
      alt=""
      aria-hidden="true"
      width={WORDMARK_W}
      height={WORDMARK_H}
    />
  );

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

/**
 * BadaBhai brand lockup — Sept 2026 brand kit (two-figure monogram +
 * official BADABHAI logotype).
 *
 * The artwork lives in @badabhai/design-tokens (brand/) and is drawn as
 * CSS backgrounds by the shared `.bb-lockup*` rules, so this page shows
 * the same brand as payer-web/admin-web from one copy. Decorative —
 * the root carries the accessible name. Server-component safe (no hooks).
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

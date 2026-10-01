import type { IconName } from "./names";

/**
 * Token-driven glyph sizes. Each maps to a class in `icons.css` (`bb-icon--sm|md|lg` →
 * `--icon-size-sm|md|lg`), never to an inline pixel value. Omit it to inherit the surrounding
 * font size, which is how a control sizes its own icon (see the button rules in each app).
 */
export type IconSize = "sm" | "md" | "lg";

export interface IconProps {
  /** The Phosphor FILL glyph. A typo fails typecheck. */
  name: IconName;
  /** Token-driven size. Omit to inherit the surrounding font size. */
  size?: IconSize;
  /** Extra classes (an app's own positioning hook, e.g. `pnav__icon`). */
  className?: string;
  /**
   * Only for an icon that carries meaning ON ITS OWN, with no visible text beside it (a status
   * mark in a matrix cell). It becomes `role="img"` named by this text. Leave it out everywhere
   * else: an icon next to a label is decorative, and naming it would make a screen reader say
   * the action twice. An icon-only CONTROL is named by the control (see `IconOnlyControlProps`),
   * never by its glyph. An empty or blank label is treated as absent (decorative): a
   * `role="img"` with no name would be announced as an unlabelled image.
   */
  label?: string;
}

/**
 * A Phosphor FILL glyph from the self-hosted icon font (`@badabhai/icons/icons.css`).
 *
 * Decorative by default: `aria-hidden`, so the text beside it carries the meaning. Colour is the
 * current text colour, so a control's hover / active / disabled state recolours its icon with
 * no icon-specific rule. Server-safe (no hooks, no handlers).
 */
export function Icon({ name, size, className, label }: IconProps) {
  const cls = ["ph-fill", `ph-${name}`, size ? `bb-icon--${size}` : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  if (label !== undefined && label.trim() !== "") {
    return <i className={cls} role="img" aria-label={label} />;
  }
  return <i className={cls} aria-hidden="true" />;
}

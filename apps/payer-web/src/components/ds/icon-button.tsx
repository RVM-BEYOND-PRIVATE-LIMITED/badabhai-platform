/**
 * BadaBhai Design System — IconButton: the ONE icon-only control (payer-web).
 *
 * A thin skin over the shared `IconButtonBase` (@badabhai/icons/button), which implements the
 * icon-only-control contract once for both portals: a REQUIRED `label` that is the only
 * accessible name (`aria-label` / `aria-labelledby` / `title` are not accepted), a visible
 * tooltip on hover and keyboard focus, Escape dismissal whether the tooltip was opened by focus
 * or by hover, a native `<button>`. This file only maps payer-web's typed variants and sizes onto
 * the `.bb-iconbtn` classes (ds-components.css: colours, sizes, the ≥44px coarse-pointer hit
 * area); the tooltip itself is `.bb-icon-tip` in @badabhai/icons/icons.css.
 *
 * Shared (no "use client" here): it adds no handler of its own; IconButtonBase carries the
 * client boundary.
 */
import { IconButtonBase, type IconButtonBaseProps } from "@badabhai/icons/button";

export interface IconButtonProps extends Omit<IconButtonBaseProps, "classBase" | "modifiers"> {
  /** @default 'ghost' */
  variant?: "ghost" | "solid" | "outline";
  /** @default 'md' */
  size?: "sm" | "md" | "lg";
}

export function IconButton({ variant = "ghost", size = "md", ...rest }: IconButtonProps) {
  return (
    <IconButtonBase
      {...rest}
      classBase="bb-iconbtn"
      modifiers={[variant !== "ghost" && variant, size !== "md" && size]}
    />
  );
}

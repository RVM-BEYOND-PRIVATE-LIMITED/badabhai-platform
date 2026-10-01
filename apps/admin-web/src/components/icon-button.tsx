/**
 * IconButton — the ONE icon-only control in the admin portal.
 *
 * A thin skin over the shared `IconButtonBase` (@badabhai/icons/button) — the same component
 * payer-web's DS IconButton wraps, so both portals honour one contract from one implementation:
 * a REQUIRED `label` that is the only accessible name (`aria-label` / `aria-labelledby` / `title`
 * are not accepted), a visible tooltip on hover and keyboard focus, Escape dismissal whether the
 * tooltip was opened by focus or by hover (never swallowed: the shell's drawer, which also closes
 * on Escape, still does), a native `<button>`. This file only maps the console's variants and
 * sizes onto the `.iconbtn` classes (globals.css: colours, sizes, the ≥44px coarse-pointer hit
 * area); the tooltip itself is `.bb-icon-tip` in @badabhai/icons/icons.css.
 */
import { IconButtonBase, type IconButtonBaseProps } from "@badabhai/icons/button";

export interface IconButtonProps extends Omit<IconButtonBaseProps, "classBase" | "modifiers"> {
  /** `outline` draws the hairline border the console's chrome controls use. @default 'ghost' */
  variant?: "ghost" | "outline";
  /** @default 'md' */
  size?: "sm" | "md";
}

export function IconButton({ variant = "ghost", size = "md", ...rest }: IconButtonProps) {
  return (
    <IconButtonBase
      {...rest}
      classBase="iconbtn"
      modifiers={[variant !== "ghost" && variant, size !== "md" && size]}
    />
  );
}

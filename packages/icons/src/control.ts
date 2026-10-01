import type { IconName } from "./names";

/**
 * THE ICON-ONLY CONTROL CONTRACT — shared by payer-web's DS `IconButton` and admin-web's
 * `IconButton`, which differ only in their class vocabulary (`bb-iconbtn` / `iconbtn`).
 *
 *   1. A REQUIRED accessible label. It is the control's only accessible name (`aria-label`) —
 *      the components omit `aria-label`, `aria-labelledby` and `title` from their props, so a
 *      caller cannot name the control twice or fall back to a title-only hint.
 *   2. A VISIBLE tooltip showing that label, on pointer hover AND on keyboard focus
 *      (`:focus-visible`) — not the browser's `title` bubble, which never appears for keyboard
 *      or touch users. The tooltip is hoverable (the pointer can move onto it) and Escape
 *      dismisses it without moving focus (WCAG 1.4.13).
 *   3. Keyboard access: a native `<button>`, so Tab / Enter / Space work with no extra code.
 *   4. A hit area of at least 44×44 CSS px on a phone or any coarse pointer, even at the dense
 *      `sm` size (the app CSS extends the hit area, not the drawn control).
 */
export interface IconOnlyControlProps {
  /** The glyph. */
  icon: IconName;
  /** REQUIRED accessible name — also the visible tooltip text. Never empty. */
  label: string;
  /** Which side of the control the tooltip opens on. @default "top" */
  tooltipPlacement?: TooltipPlacement;
  /*
   * Forbidden, not merely omitted. TSX does not excess-check a HYPHENATED attribute that a props
   * type leaves undeclared (`aria-*`, `data-*`), so `Omit<…, "aria-label">` alone would still
   * accept `aria-label="…"`; typing it `never` turns a second name into a compile error.
   */
  /** Not accepted — the name is `label`. */
  "aria-label"?: never;
  /** Not accepted — the name is `label`. */
  "aria-labelledby"?: never;
  /** Not accepted — the visible tooltip replaces the title bubble. */
  title?: never;
}

/** `start` / `end` follow the writing direction (left / right in LTR). */
export type TooltipPlacement = "top" | "bottom" | "start" | "end";

/**
 * The attribute both apps' tooltip CSS keys the Escape dismissal on. Set on the control by
 * {@link dismissTooltipOnEscape}, cleared by {@link restoreTooltip} on blur / pointer leave,
 * so the tooltip comes back the next time the control is hovered or focused.
 */
export const TOOLTIP_DISMISSED_ATTRIBUTE = "data-tooltip-dismissed";

/**
 * Hide the tooltip when Escape is pressed on the control. Returns whether it acted. It does NOT
 * stop propagation: an enclosing drawer or dialog that also closes on Escape still does.
 */
export function dismissTooltipOnEscape(
  control: Pick<Element, "setAttribute">,
  key: string,
): boolean {
  if (key !== "Escape") return false;
  control.setAttribute(TOOLTIP_DISMISSED_ATTRIBUTE, "");
  return true;
}

/** Re-arm the tooltip once focus or the pointer has left the control. */
export function restoreTooltip(control: Pick<Element, "removeAttribute">): void {
  control.removeAttribute(TOOLTIP_DISMISSED_ATTRIBUTE);
}

/**
 * Dev-only guard for the one rule the type system cannot express: the label must say
 * something. An empty name is an unlabelled button to a screen reader and an empty tooltip to
 * everyone else. Stripped from production builds by the `NODE_ENV` check.
 */
export function warnIfUnlabelled(label: string, component: string): void {
  if (process.env.NODE_ENV === "production") return;
  if (label.trim() === "") {
    console.error(
      `[bb-icons] ${component}: \`label\` is empty. An icon-only control needs a non-empty ` +
        "label — it is the control's accessible name and its visible tooltip.",
    );
  }
}

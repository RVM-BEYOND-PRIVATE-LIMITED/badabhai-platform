import type { IconName } from "./names";

/**
 * THE ICON-ONLY CONTROL CONTRACT — implemented ONCE by `IconButtonBase`
 * (`@badabhai/icons/button`); payer-web's DS `IconButton` and admin-web's `IconButton` are thin
 * wrappers that only choose their class vocabulary (`bb-iconbtn` / `iconbtn`) and variants.
 *
 *   1. A REQUIRED accessible label. It is the control's only accessible name (`aria-label`):
 *      `aria-label`, `aria-labelledby` and `title` are typed `never`, so a caller cannot name the
 *      control twice or fall back to a title-only hint.
 *   2. A VISIBLE tooltip showing that label, on pointer hover AND on keyboard focus
 *      (`:focus-visible`) — not the browser's `title` bubble, which never appears for keyboard or
 *      touch users. A hover-opened tooltip is hoverable (the pointer can move onto it); Escape
 *      dismisses the tooltip without moving focus or the pointer (WCAG 1.4.13), whether it was
 *      opened by focus (keydown on the control) or by hover (keydown on the document, watched
 *      only while the pointer is over the control — {@link watchEscapeWhileHovered}).
 *   3. Keyboard access: a native `<button>`, so Tab / Enter / Space work with no extra code.
 *   4. A hit area of at least 44×44 CSS px on a phone or any coarse pointer, even at the dense
 *      `sm` size (the app CSS extends the hit area, not the drawn control).
 */
export interface IconOnlyControlProps {
  /** The glyph. */
  icon: IconName;
  /** REQUIRED accessible name — also the visible tooltip text. Never empty. */
  label: string;
  /** Where the tooltip opens. @default "top" */
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

/**
 * Where the tooltip opens, relative to its control.
 *
 * - `top` / `bottom` centre it on the control.
 * - `-start` / `-end` keep it on that side but align its start or end EDGE with the control's,
 *   so it grows inward. Use these near a viewport edge: `bottom-end` for a top-right control (a
 *   dialog ✕), `bottom-start` for a top-left one (a drawer toggle).
 * - `start` / `end` put it beside the control, vertically centred.
 *
 * `start` and `end` follow the writing direction (left and right in LTR).
 *
 * The type is derived from this one tuple, so a new placement cannot be added to the type
 * without also reaching the tests and tooling that iterate the list (the CSS test checks a
 * rule exists for every entry).
 */
export const TOOLTIP_PLACEMENTS = [
  "top",
  "top-start",
  "top-end",
  "bottom",
  "bottom-start",
  "bottom-end",
  "start",
  "end",
] as const;

export type TooltipPlacement = (typeof TOOLTIP_PLACEMENTS)[number];

/**
 * The attribute the tooltip CSS (`icons.css`) keys the Escape dismissal on. Set on the control by
 * {@link dismissTooltipOnEscape}, cleared by {@link restoreTooltip} on blur / pointer leave, so
 * the tooltip comes back the next time the control is hovered or focused.
 */
export const TOOLTIP_DISMISSED_ATTRIBUTE = "data-tooltip-dismissed";

/**
 * Hide the tooltip when Escape is pressed. Returns whether it acted. It does NOT stop
 * propagation: an enclosing drawer or dialog that also closes on Escape still does.
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

/** What {@link focusWithoutTooltip} needs from the target (any `HTMLElement` fits). */
export interface FocusArrivalTarget {
  readonly children: ArrayLike<{ readonly classList: Pick<DOMTokenList, "contains"> }>;
  setAttribute(name: string, value: string): void;
  focus(): void;
}

/**
 * Move focus to a control the APP chose — a dialog's first focusable on open, the menu button a
 * closing drawer hands focus back to — WITHOUT opening that control's tooltip.
 *
 * The tooltip shows on keyboard focus (`:focus-visible`), but focus the app put there is not the
 * user pointing at the control: a dialog opened from the keyboard lands on its ✕, and the "Close"
 * bubble covered the first line of the body, dismissable only by Escape — which also closes the
 * dialog (WCAG 1.4.13). So a control with a `.bb-icon-tip` child arrives with the tooltip already
 * dismissed ({@link TOOLTIP_DISMISSED_ATTRIBUTE}); its own blur / pointer leave re-arm it
 * ({@link restoreTooltip}), so moving away and back shows it as usual. Any other target is focused
 * untouched (an attribute nothing would ever clear is never left behind).
 */
export function focusWithoutTooltip(target: FocusArrivalTarget): void {
  if (Array.from(target.children).some((c) => c.classList.contains("bb-icon-tip"))) {
    target.setAttribute(TOOLTIP_DISMISSED_ATTRIBUTE, "");
  }
  target.focus();
}

/** What {@link watchEscapeWhileHovered} needs from the control (an `HTMLButtonElement` fits). */
export interface HoverEscapeTarget {
  readonly isConnected: boolean;
  readonly ownerDocument: Pick<Document, "addEventListener" | "removeEventListener">;
  setAttribute(name: string, value: string): void;
}

// The options-object form, not the boolean `true`: equivalent in browsers, but some EventTarget
// implementations (Node's) fail to match a boolean capture flag on removal — a silent leak.
const CAPTURE: AddEventListenerOptions = { capture: true };

/**
 * Escape for a HOVER-opened tooltip. A control the pointer is merely resting on is usually not
 * focused, so its own keydown never fires; this listens on the control's DOCUMENT instead, in
 * the capture phase (so a handler that stops propagation further down cannot hide the key from
 * it) and without stopping propagation itself (a drawer or dialog that closes on Escape still
 * does). Call it on pointer enter; call the returned `stop` on pointer leave AND on unmount.
 *
 * `stop` is idempotent. As a second line of defence the listener also removes itself the first
 * time it fires after the control has left the document.
 */
export function watchEscapeWhileHovered(control: HoverEscapeTarget): () => void {
  const doc = control.ownerDocument;
  let active = true;
  const onKeyDown = (event: Event): void => {
    if (!control.isConnected) {
      stop();
      return;
    }
    dismissTooltipOnEscape(control, (event as KeyboardEvent).key);
  };
  function stop(): void {
    if (!active) return;
    active = false;
    doc.removeEventListener("keydown", onKeyDown, CAPTURE);
  }
  doc.addEventListener("keydown", onKeyDown, CAPTURE);
  return stop;
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

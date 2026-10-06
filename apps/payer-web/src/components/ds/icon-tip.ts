"use client";

/**
 * The shared tooltip's (`.bb-icon-tip`, @badabhai/icons/icons.css) Escape / re-arm wiring for an
 * icon-only control that keeps its OWN markup, so it cannot be an `IconButtonBase` — the theme
 * switch draws a track and a thumb, not one glyph. Same behaviour as IconButtonBase, through the
 * same shared helpers:
 *   - Escape dismisses the tooltip whether it was opened by keyboard focus (the control's own
 *     keydown) or by hover (a document listener added on pointer enter — the hovered control is
 *     usually not focused — and removed on pointer leave and on unmount);
 *   - blur / pointer leave re-arm it for the next hover or focus.
 * Escape is never swallowed: an enclosing drawer or dialog still gets it.
 *
 * Spread the result onto the control, and render the tooltip as its direct child:
 *   <button aria-label={label} {...useIconTipHandlers()}>
 *     …
 *     <span className="bb-icon-tip bb-icon-tip--bottom" aria-hidden="true">{label}</span>
 *   </button>
 */
import { useEffect, useRef } from "react";
import type { FocusEvent, KeyboardEvent, PointerEvent } from "react";
import { dismissTooltipOnEscape, restoreTooltip, watchEscapeWhileHovered } from "@badabhai/icons";

export interface IconTipHandlers {
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onBlur: (e: FocusEvent<HTMLElement>) => void;
  onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
}

export function useIconTipHandlers(): IconTipHandlers {
  // The document Escape listener of the current hover, if any.
  const stopHoverEscape = useRef<(() => void) | null>(null);
  // Unmounted while hovered: the pointer never "leaves", so remove the listener here.
  useEffect(
    () => () => {
      stopHoverEscape.current?.();
      stopHoverEscape.current = null;
    },
    [],
  );
  return {
    onKeyDown: (e) => {
      dismissTooltipOnEscape(e.currentTarget, e.key);
    },
    onBlur: (e) => restoreTooltip(e.currentTarget),
    onPointerEnter: (e) => {
      stopHoverEscape.current?.();
      stopHoverEscape.current = watchEscapeWhileHovered(e.currentTarget);
    },
    onPointerLeave: (e) => {
      stopHoverEscape.current?.();
      stopHoverEscape.current = null;
      restoreTooltip(e.currentTarget);
    },
  };
}

"use client";

/**
 * IconButtonBase — the ONE implementation of the icon-only-control contract
 * (`IconOnlyControlProps`, ./control.ts). payer-web's DS `IconButton` and admin-web's
 * `IconButton` are thin wrappers that pick a class root and their typed variants; everything
 * behavioural lives here, once:
 *   - the label is the only accessible name (`aria-label`, written AFTER the props spread so
 *     nothing can override it at runtime) and the visible tooltip text;
 *   - the tooltip (`.bb-icon-tip`, styled in icons.css) shows on hover and keyboard focus;
 *   - Escape dismisses it — via the control's own keydown when focused, and via a document
 *     listener while the pointer is over it ({@link watchEscapeWhileHovered}); the listener is
 *     removed on pointer leave and on unmount;
 *   - blur / pointer leave re-arm it.
 *
 * The Escape / re-arm wiring itself is {@link useIconTipHandlers}, exported for the one kind of
 * control that cannot be this button: one that keeps its own markup around the shared tooltip
 * (payer-web's theme switch draws a track and a thumb, not one glyph). Same hook, same behaviour.
 *
 * Its own subpath (`@badabhai/icons/button`), NOT the package index: it is a client module
 * (hooks + handlers), and the index stays importable from Server Components.
 */
import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Icon } from "./icon";
import {
  dismissTooltipOnEscape,
  restoreTooltip,
  warnIfUnlabelled,
  watchEscapeWhileHovered,
  type IconOnlyControlProps,
} from "./control";

export interface IconButtonBaseProps
  extends
    Omit<
      ButtonHTMLAttributes<HTMLButtonElement>,
      "children" | "aria-label" | "aria-labelledby" | "title"
    >,
    IconOnlyControlProps {
  /** The app's class root — `bb-iconbtn` (payer-web) or `iconbtn` (admin-web). */
  classBase: string;
  /**
   * Modifier suffixes the wrapper derived from its OWN typed props (variant, size); each becomes
   * `${classBase}--${modifier}`. Falsy entries are skipped, so a wrapper can pass
   * `[variant !== "ghost" && variant]`.
   */
  modifiers?: ReadonlyArray<string | false | null | undefined>;
}

/** The four handlers that wire a control's `.bb-icon-tip` child (see {@link useIconTipHandlers}). */
export interface IconTipHandlers {
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  onBlur: (e: FocusEvent<HTMLElement>) => void;
  onPointerEnter: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (e: PointerEvent<HTMLElement>) => void;
}

/**
 * The shared tooltip's Escape / re-arm wiring, for a control whose DIRECT child is the
 * `.bb-icon-tip` (the CSS shows `:focus-visible > .bb-icon-tip` / `:hover > .bb-icon-tip`):
 *   - Escape dismisses it whether it was opened by keyboard focus (the control's own keydown) or
 *     by hover (a capture-phase document listener added on pointer enter — the hovered control is
 *     usually not focused — and removed on pointer leave and on unmount);
 *   - blur / pointer leave re-arm it for the next hover or focus, and pointer ENTER re-arms it
 *     too: a new hover is a new request, so a tip kept quiet for focus the app moved there
 *     (`focusWithoutTooltip`, a dialog's ✕ on open) still shows to the mouse. Escape while
 *     hovering dismisses it again.
 * Escape is never swallowed: an enclosing drawer or dialog that closes on Escape still does.
 *
 * `IconButtonBase` is built on it; a control that keeps its own markup spreads it:
 *   <button aria-label={label} {...useIconTipHandlers()}>…<span className="bb-icon-tip …">
 */
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
      restoreTooltip(e.currentTarget);
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

export function IconButtonBase({
  classBase,
  modifiers = [],
  icon,
  label,
  tooltipPlacement = "top",
  className = "",
  type = "button",
  onKeyDown,
  onBlur,
  onPointerEnter,
  onPointerLeave,
  // Typed `never`, so only a cast can supply them — dropped so a cast cannot name it twice either.
  title: _title,
  "aria-labelledby": _labelledBy,
  ...rest
}: IconButtonBaseProps) {
  warnIfUnlabelled(label, "IconButton");
  const tip = useIconTipHandlers();

  const cls = [
    classBase,
    ...modifiers.filter((m): m is string => Boolean(m)).map((m) => `${classBase}--${m}`),
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      {...rest}
      /* After the spread: the contract's name and type cannot be overridden at runtime. */
      type={type}
      className={cls}
      aria-label={label}
      onKeyDown={(e) => {
        tip.onKeyDown(e);
        onKeyDown?.(e);
      }}
      onBlur={(e) => {
        tip.onBlur(e);
        onBlur?.(e);
      }}
      onPointerEnter={(e) => {
        tip.onPointerEnter(e);
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e) => {
        tip.onPointerLeave(e);
        onPointerLeave?.(e);
      }}
    >
      <Icon name={icon} />
      <span className={`bb-icon-tip bb-icon-tip--${tooltipPlacement}`} aria-hidden="true">
        {label}
      </span>
    </button>
  );
}

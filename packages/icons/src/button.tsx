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
 * Its own subpath (`@badabhai/icons/button`), NOT the package index: it is a client module
 * (hooks + handlers), and the index stays importable from Server Components.
 */
import { useEffect, useRef, type ButtonHTMLAttributes } from "react";
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
        dismissTooltipOnEscape(e.currentTarget, e.key);
        onKeyDown?.(e);
      }}
      onBlur={(e) => {
        restoreTooltip(e.currentTarget);
        onBlur?.(e);
      }}
      onPointerEnter={(e) => {
        stopHoverEscape.current?.();
        stopHoverEscape.current = watchEscapeWhileHovered(e.currentTarget);
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e) => {
        stopHoverEscape.current?.();
        stopHoverEscape.current = null;
        restoreTooltip(e.currentTarget);
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

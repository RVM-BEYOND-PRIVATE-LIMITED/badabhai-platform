"use client";

/**
 * BadaBhai Design System — Dialog (centered modal / bottom sheet).
 *
 * Client primitive: wires Esc-to-close, scrim-click-to-close, and modal FOCUS management —
 * on open it saves the trigger, moves focus into the dialog, and TRAPS Tab / Shift+Tab
 * within the dialog's focusable set (wrapping first↔last); on close it restores focus to the
 * trigger. While open it ISOLATES THE PAGE (./page-isolation.ts): everything outside the dialog
 * is `inert` and the page does not scroll under the scrim. Controlled via `open`.
 * Presentational only — the caller owns the open state + actions (e.g. confirm-on-spend lives in
 * the screen, not here). Prop contract mirrors docs/design/.../components/feedback/Dialog.d.ts.
 */
import { useEffect, useId, useRef } from "react";
import type { MouseEvent, ReactNode } from "react";
import { ACTION_ICON, focusWithoutTooltip } from "@badabhai/icons";
import { FOCUSABLE_SELECTOR } from "./focusable";
import { IconButton } from "./icon-button";
import { inertOutside, lockPageScroll } from "./page-isolation";

export interface DialogProps {
  /** Controls visibility. */
  open: boolean;
  /** Close handler (Esc, scrim click, ✕ button). Omit to hide the ✕. */
  onClose?: () => void;
  /** Heading text. */
  title?: ReactNode;
  /** Body content. */
  children?: ReactNode;
  /** Footer node — usually the action buttons. */
  footer?: ReactNode;
  /** Render as a bottom sheet (mobile pattern) instead of centered. */
  sheet?: boolean;
  /** Close when the scrim is clicked. @default true */
  closeOnScrim?: boolean;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  sheet = false,
  closeOnScrim = true,
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // A per-instance id (never a shared literal) so two open dialogs can't collide their
  // `aria-labelledby` target. Only wired when a title actually renders.
  const generatedId = useId();
  const titleId = title ? generatedId : undefined;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && onClose) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // FOCUS MANAGEMENT — save the trigger, move focus in, trap Tab within the dialog, restore
  // the trigger on close. Keyed on `open` so it arms exactly when the dialog is in the DOM.
  useEffect(() => {
    if (!open) return undefined;
    const dialogEl = dialogRef.current;
    if (!dialogEl) return undefined;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // ISOLATE THE PAGE behind the dialog: inert (no click, focus, find or virtual cursor reaches
    // it) and still (no scroll under the scrim). After saving the trigger — inert blurs it.
    // NESTING: open a second Dialog only from INSIDE this one — anywhere else in the page is
    // inert while this is open (see page-isolation.ts).
    const releaseInert = inertOutside(dialogEl, document.body);
    const releaseScroll = lockPageScroll(document.documentElement, window.innerWidth);

    const focusable = (): HTMLElement[] =>
      Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // Move focus into the dialog — its first focusable, else the dialog container itself. That is
    // usually the ✕: focus the DIALOG put there must not open its "Close" tooltip over the body
    // (on a keyboard open it covered ConfirmSpendDialog's first line, and Escape — its only
    // dismissal — also closes the dialog). Blur re-arms it; a later Tab back to the ✕ shows it.
    const initial = focusable();
    focusWithoutTooltip(initial[0] ?? dialogEl);

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        dialogEl.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !dialogEl.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialogEl.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    dialogEl.addEventListener("keydown", onKeyDown);
    return () => {
      dialogEl.removeEventListener("keydown", onKeyDown);
      // Hand the page back FIRST: an inert trigger cannot take focus.
      releaseInert();
      releaseScroll();
      // Restore focus to whatever opened the dialog (keyboard users land back where they were).
      if (previouslyFocused && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [open]);

  if (!open) return null;

  const onScrimClick = closeOnScrim
    ? (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }
    : undefined;

  return (
    <div className={`bb-scrim ${sheet ? "bb-scrim--sheet" : ""}`} onClick={onScrimClick}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        className={`bb-dialog ${sheet ? "bb-dialog--sheet" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        {(title || onClose) && (
          <div className="bb-dialog__head">
            {title && (
              <h3 className="bb-dialog__title" id={titleId}>
                {title}
              </h3>
            )}
            {/* The shared icon-only control: "Close" is its name and its visible tooltip, which
                opens inward from the dialog's top-right corner. */}
            {onClose && (
              <IconButton
                icon={ACTION_ICON.close}
                label="Close"
                tooltipPlacement="bottom-end"
                onClick={onClose}
              />
            )}
          </div>
        )}
        {children && <div className="bb-dialog__body">{children}</div>}
        {footer && <div className="bb-dialog__foot">{footer}</div>}
      </div>
    </div>
  );
}

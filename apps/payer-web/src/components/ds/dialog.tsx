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
 *
 * A JUST-OPENED DIALOG IGNORES A POINTER CLICK ON ITS ACTIONS (review N1). A fast double-click — or
 * a phone tap that registers twice — on a trigger opens the dialog on the first click and lands the
 * second wherever the dialog's confirm now sits, confirming what nobody read (a purchase, an
 * unlock). For {@link DIALOG_ACTION_GUARD_MS} after open, a pointer click inside the footer (the
 * actions slot) is stopped before it reaches the button. Keyboard activation — Enter / Space on a
 * focused button, a click with `detail === 0` — is never held back. The body and head are not
 * guarded, and no caller's copy changes.
 *
 * MOTION (#2583): it rises in (opacity + a short rise + 0.98 → 1 scale, --duration-base) and, at
 * ≤ 600px, is a bottom sheet sliding up (--duration-sheet) with stacked full-width actions and a
 * 90dvh ceiling (ds-components.css). On close it LEAVES as well: React unmounts the dialog at
 * once (focus, inert and scroll are handed back immediately — the exit never delays input), and
 * an inert, aria-hidden snapshot of it plays the exit and removes itself ({@link playExit}).
 * Under reduced motion — or wherever no exit animation applies — there is no snapshot at all.
 */
import { useEffect, useId, useRef } from "react";
import type { MouseEvent, ReactNode } from "react";
import { ACTION_ICON, focusWithoutTooltip } from "@badabhai/icons";
import { FOCUSABLE_SELECTOR } from "./focusable";
import { IconButton } from "./icon-button";
import { inertOutside, lockPageScroll } from "./page-isolation";

/**
 * How long after open a POINTER click on an action is ignored: the OS default double-click
 * interval, so a double-click's second press (or a doubled tap) is caught — and far too short for
 * anyone to have read the dialog and meant it.
 */
export const DIALOG_ACTION_GUARD_MS = 500;

/** The data-state a closing snapshot carries; the stylesheet keys the exit animation on it. */
export const DIALOG_CLOSING_STATE = "closing";

/** The longest an exit snapshot may live if its animationend never arrives (a hidden tab). */
const EXIT_FALLBACK_MS = 1000;

/**
 * Play the dialog's exit on a detached SNAPSHOT of its scrim, so React can unmount the live
 * dialog straight away. The snapshot is aria-hidden and inert — it is a picture, not a dialog —
 * and removes itself when its exit animation ends. It goes on <body> (the scrim is fixed, so it
 * paints in the same place), never back into a container React manages. No snapshot under reduced motion, or when the
 * stylesheet gives the closing state no animation (nothing to watch — e.g. a test DOM).
 */
export function playExit(scrim: Element | null | undefined): void {
  const parent = scrim?.ownerDocument?.body;
  if (!scrim || !parent || typeof window === "undefined") return;
  if (typeof window.getComputedStyle !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  const ghost = scrim.cloneNode(true) as HTMLElement;
  ghost.setAttribute("data-state", DIALOG_CLOSING_STATE);
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.removeAttribute("id");
  parent.appendChild(ghost);
  const box = ghost.querySelector(".bb-dialog") ?? ghost;
  const name = window.getComputedStyle(box).animationName;
  if (!name || name === "none") {
    ghost.remove();
    return;
  }
  const done = () => ghost.remove();
  box.addEventListener("animationend", done, { once: true });
  window.setTimeout(done, EXIT_FALLBACK_MS);
}

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
  // When this dialog opened (`performance.now()` — the clock event time stamps share); null while
  // closed or before the open effect has run, which the guard treats as "just opened".
  const openedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    openedAt.current = performance.now();
    return () => {
      openedAt.current = null;
    };
  }, [open]);

  /** Stop a pointer click on an action that lands inside the guard window after open. */
  function guardActions(e: MouseEvent<HTMLDivElement>) {
    if (e.detail === 0) return; // keyboard (Enter / Space) or programmatic — never held back
    const at = openedAt.current;
    if (at !== null && e.timeStamp - at >= DIALOG_ACTION_GUARD_MS) return;
    e.preventDefault();
    e.stopPropagation();
  }

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
    // The scrim, remembered for the exit snapshot (React detaches it before the cleanup runs).
    const scrimEl = dialogEl.parentElement;

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
      // The exit plays on a snapshot of the scrim.
      playExit(scrimEl);
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
              // h2: a dialog is its own top-level section under the page's h1 (#2583).
              <h2 className="bb-dialog__title" id={titleId}>
                {title}
              </h2>
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
        {footer && (
          // Capture phase: the click is stopped here, before any action button's onClick runs.
          <div className="bb-dialog__foot" onClickCapture={guardActions}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

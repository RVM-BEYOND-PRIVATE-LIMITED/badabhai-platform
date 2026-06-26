"use client";

/**
 * BadaBhai Design System — Dialog (centered modal / bottom sheet).
 *
 * Client primitive: wires Esc-to-close and scrim-click-to-close. Controlled via `open`.
 * Presentational only — the caller owns the open state + actions (e.g. confirm-on-spend
 * lives in the screen, not here). Prop contract mirrors
 * docs/design/.../components/feedback/Dialog.d.ts.
 */
import { useEffect } from "react";
import type { MouseEvent, ReactNode } from "react";

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
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && onClose) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const onScrimClick = closeOnScrim
    ? (e: MouseEvent<HTMLDivElement>) => {
        if (e.target === e.currentTarget && onClose) onClose();
      }
    : undefined;

  return (
    <div className={`bb-scrim ${sheet ? "bb-scrim--sheet" : ""}`} onClick={onScrimClick}>
      <div className={`bb-dialog ${sheet ? "bb-dialog--sheet" : ""}`} role="dialog" aria-modal="true">
        {(title || onClose) && (
          <div className="bb-dialog__head">
            {title && <h3 className="bb-dialog__title">{title}</h3>}
            {onClose && (
              <button className="bb-iconbtn" aria-label="Close" onClick={onClose}>
                <i className="ph ph-x" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
        {children && <div className="bb-dialog__body">{children}</div>}
        {footer && <div className="bb-dialog__foot">{footer}</div>}
      </div>
    </div>
  );
}

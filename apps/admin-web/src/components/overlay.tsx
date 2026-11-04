"use client";

import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { holdFocus } from "./overlay-focus";
import { usePresence } from "./presence";

export interface OverlayProps {
  /** `dialog` is centred; `drawer` is anchored to the right edge (globals.css `.overlay--*`). */
  kind: "dialog" | "drawer";
  open: boolean;
  /** Called on Escape, on a scrim click and by the panel's own close controls. */
  onClose: () => void;
  /** The id of the visible title — the panel's accessible name. */
  labelledBy: string;
  describedBy?: string;
  /** Where focus starts; the panel's first control when omitted. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/**
 * The modal layer Dialog and Drawer share (A5, #2575): a scrim plus a `role="dialog"` panel.
 *
 * While open, focus is held inside the panel (`holdFocus`): it starts on `initialFocusRef` or the
 * first control, Tab wraps, Escape closes, and on close focus returns to whatever held it when
 * the overlay opened — the trigger. Closing plays the exit motion first (`usePresence`), then
 * unmounts.
 *
 * Rendered into `document.body` once mounted, so no transformed ancestor (the page's own enter
 * motion) can become the fixed panel's containing block. Before mount — the server render — it
 * renders in place, which only ever happens for an overlay that starts open.
 */
export function Overlay({
  kind,
  open,
  onClose,
  labelledBy,
  describedBy,
  initialFocusRef,
  children,
}: OverlayProps) {
  const presence = usePresence(open);
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => setHost(document.body), []);

  useEffect(() => {
    if (!open || !panelRef.current) return;
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return holdFocus({
      container: panelRef.current,
      keyTarget: window,
      activeElement: () => document.activeElement,
      onEscape: () => onCloseRef.current(),
      initial: initialFocusRef?.current ?? null,
      returnTo,
    });
    // `host` re-runs it once the panel has moved into the portal.
  }, [open, host, initialFocusRef]);

  if (presence === "closed") return null;

  const layer = (
    <div className={`overlay overlay--${kind}`} data-state={presence}>
      <div className="overlay__scrim" aria-hidden="true" onClick={() => onCloseRef.current()} />
      <div
        ref={panelRef}
        className="overlay__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
      >
        {children}
      </div>
    </div>
  );
  return host ? createPortal(layer, host) : layer;
}

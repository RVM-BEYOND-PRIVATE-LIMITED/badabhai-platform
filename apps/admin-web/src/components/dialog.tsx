"use client";

import { useId, type ReactNode, type RefObject } from "react";
import { ACTION_ICON } from "@badabhai/icons";
import { IconButton } from "./icon-button";
import { Overlay } from "./overlay";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One line under the title, read as the dialog's description. */
  description?: ReactNode;
  children: ReactNode;
  /** The action row (Cancel + the one primary action), pinned under the body. */
  footer?: ReactNode;
  /** Where focus starts; the close button when omitted. */
  initialFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * A centred modal dialog (A5, #2575). Focus is trapped while open, Escape and the scrim close it,
 * and focus returns to the control that opened it (`Overlay`).
 *
 * Motion (globals.css `.overlay--dialog`): the scrim fades in and the panel rises from 6px below
 * and scales 0.98 → 1 over --duration-base on --ease-enter; it leaves over --duration-fast on
 * --ease-exit. Every one of those is 0 under prefers-reduced-motion.
 */
export function Dialog(props: DialogProps) {
  return <OverlayFrame kind="dialog" {...props} />;
}

/** The panel layout Dialog and Drawer share: title row, scrolling body, pinned action row. */
export function OverlayFrame({
  kind,
  open,
  onClose,
  title,
  description,
  children,
  footer,
  initialFocusRef,
}: DialogProps & { kind: "dialog" | "drawer" }) {
  const id = useId();
  const titleId = `${id}-title`;
  const descId = description ? `${id}-desc` : undefined;
  return (
    <Overlay
      kind={kind}
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={descId}
      initialFocusRef={initialFocusRef}
    >
      <OverlayHeader titleId={titleId} title={title} onClose={onClose}>
        {description ? (
          <p className="overlay__sub" id={descId}>
            {description}
          </p>
        ) : null}
      </OverlayHeader>
      <div className="overlay__body">{children}</div>
      {footer ? <div className="overlay__foot">{footer}</div> : null}
    </Overlay>
  );
}

/** The title row Dialog and Drawer share: heading, optional description, and the close button. */
function OverlayHeader({
  titleId,
  title,
  onClose,
  children,
}: {
  titleId: string;
  title: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="overlay__head">
      <div className="overlay__heading">
        <h2 className="overlay__title" id={titleId}>
          {title}
        </h2>
        {children}
      </div>
      <IconButton icon={ACTION_ICON.close} label="Close" onClick={onClose} />
    </div>
  );
}

import * as React from 'react';

export interface DialogProps {
  /** Controls visibility. */
  open: boolean;
  /** Close handler (Esc, scrim click, ✕ button). Omit to hide the ✕. */
  onClose?: () => void;
  /** Heading text. */
  title?: React.ReactNode;
  /** Body content. */
  children?: React.ReactNode;
  /** Footer node — usually the action buttons. */
  footer?: React.ReactNode;
  /** Render as a bottom sheet (mobile pattern) instead of centered. */
  sheet?: boolean;
  /** Close when the scrim is clicked. @default true */
  closeOnScrim?: boolean;
}

/** Modal dialog / bottom sheet. The card pops in with the brand spring. */
export declare function Dialog(props: DialogProps): JSX.Element | null;

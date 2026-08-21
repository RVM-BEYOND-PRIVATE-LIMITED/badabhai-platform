import * as React from 'react';

export interface ToastProps extends React.HTMLAttributes<HTMLDivElement> {
  /** @default 'neutral' */
  tone?: 'neutral' | 'success' | 'danger' | 'brand';
  /** Override the default Phosphor glyph for the tone. */
  icon?: string;
  /** Bold first line. */
  title?: React.ReactNode;
  /** Supporting message (children). */
  children?: React.ReactNode;
  /** Show a dismiss ✕. */
  onClose?: () => void;
}

/** Toast on a dark ink surface (resume ready, applied, unlock confirmed). */
export declare function Toast(props: ToastProps): JSX.Element;

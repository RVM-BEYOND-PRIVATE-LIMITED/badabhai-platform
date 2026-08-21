import * as React from 'react';

export interface TooltipProps {
  /** Tooltip text. */
  label: React.ReactNode;
  /** @default 'top' */
  placement?: 'top' | 'bottom';
  /** The trigger element. */
  children: React.ReactNode;
}

/** Lightweight CSS tooltip for dense payer toolbars (pair with IconButton). */
export declare function Tooltip(props: TooltipProps): JSX.Element;

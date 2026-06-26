import * as React from 'react';

/** Props for {@link Button}. */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. `primary` (marigold) is the single CTA per screen. @default 'primary' */
  variant?: 'primary' | 'secondary' | 'tonal' | 'ghost' | 'success' | 'danger';
  /** @default 'md' */
  size?: 'sm' | 'md' | 'lg';
  /** Stretch to fill the container width. */
  block?: boolean;
  /** Phosphor glyph name rendered before the label, e.g. `'lock-key-open'`. */
  iconLeft?: string;
  /** Phosphor glyph name rendered after the label. */
  iconRight?: string;
  /** Show a spinner and disable interaction. */
  loading?: boolean;
}

/** Primary action button for BadaBhai. Marigold = the one CTA per screen. */
export declare function Button(props: ButtonProps): JSX.Element;

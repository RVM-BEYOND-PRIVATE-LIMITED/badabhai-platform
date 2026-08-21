import * as React from 'react';

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** @default 'neutral' */
  tone?: 'neutral' | 'brand' | 'success' | 'danger' | 'warning' | 'info';
  /** @default 'soft' */
  variant?: 'soft' | 'solid' | 'outline';
  /** Uppercase + wide tracking for status labels. */
  upper?: boolean;
  /** Phosphor glyph name (rendered filled), e.g. `'seal-check'`. */
  icon?: string;
}

/** Status pill. `tone="success" icon="seal-check"` is the Verified badge. */
export declare function Badge(props: BadgeProps): JSX.Element;

import * as React from 'react';

export interface ChipProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onRemove'> {
  /** Selected (marigold) state. */
  selected?: boolean;
  /** Leading Phosphor glyph name. */
  icon?: string;
  /** When provided, shows an ✕ and calls this on click. */
  onRemove?: (e: React.MouseEvent) => void;
}

/** Selectable/removable pill for trades, skills, and feed filters. */
export declare function Chip(props: ChipProps): JSX.Element;

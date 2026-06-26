import * as React from 'react';

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Phosphor glyph name, e.g. `'microphone'` (no `ph-` prefix). */
  icon: string;
  /** Accessible label — required, also used as the tooltip title. */
  label: string;
  /** @default 'ghost' */
  variant?: 'ghost' | 'solid' | 'outline';
  /** @default 'md' */
  size?: 'sm' | 'md' | 'lg';
}

/** Square icon-only button (toolbars, dense payer chrome, voice-note mic). */
export declare function IconButton(props: IconButtonProps): JSX.Element;

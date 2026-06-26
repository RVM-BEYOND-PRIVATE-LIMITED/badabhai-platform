import * as React from 'react';

export interface BadaBhaiLogoProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** @default 'full' */
  variant?: 'full' | 'mark' | 'wordmark';
  /** Surface it sits on — flips wordmark color. @default 'paper' */
  theme?: 'paper' | 'ink';
  /** Mark size in px; wordmark scales from it. @default 32 */
  size?: number;
}

/**
 * 🟠 Placeholder BadaBhai logo (no official mark was provided). Self-contained SVG mark.
 * @startingPoint section="Brand" subtitle="Logo lockups" viewport="700x160"
 */
export declare function BadaBhaiLogo(props: BadaBhaiLogoProps): JSX.Element;

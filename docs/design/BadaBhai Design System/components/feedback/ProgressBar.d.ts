import * as React from 'react';

export interface ProgressBarProps extends React.HTMLAttributes<HTMLDivElement> {
  /** 0–100. */
  value?: number;
  /** Optional label above the track. */
  label?: React.ReactNode;
  /** Show the % on the right. */
  showValue?: boolean;
  /** @default 'brand' */
  tone?: 'brand' | 'success';
  /** Thicker 14px track. */
  thick?: boolean;
}

/** Linear progress — profile completeness, resume build, vacancy quota fill. */
export declare function ProgressBar(props: ProgressBarProps): JSX.Element;

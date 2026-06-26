import * as React from 'react';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  /** `<option>` elements. */
  children?: React.ReactNode;
}

/** Native select restyled to match Input (trade, vacancy band, city). */
export declare function Select(props: SelectProps): JSX.Element;

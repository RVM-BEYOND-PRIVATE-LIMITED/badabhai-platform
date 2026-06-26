import * as React from 'react';

export interface CheckboxProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Label text beside the box. */
  label?: React.ReactNode;
}

/** Checkbox with a marigold fill (consent, multi-select filters). 48px tap row. */
export declare function Checkbox(props: CheckboxProps): JSX.Element;

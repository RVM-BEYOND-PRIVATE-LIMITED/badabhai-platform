import * as React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Field label shown above the control. */
  label?: string;
  /** Helper text below the field (hidden when `error` is set). */
  hint?: string;
  /** Error message — turns the field red and replaces the hint. */
  error?: string;
  /** Leading Phosphor glyph name, e.g. `'phone'`. */
  iconLeft?: string;
  /** Trailing Phosphor glyph name. */
  iconRight?: string;
  /** Appends a muted “· optional” to the label. */
  optional?: boolean;
}

/** Single-line text input (52px tall — a comfortable worker-app target). */
export declare function Input(props: InputProps): JSX.Element;

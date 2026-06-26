import * as React from 'react';

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  hint?: string;
  error?: string;
  optional?: boolean;
  /** @default 4 */
  rows?: number;
}

/** Multi-line text input (job descriptions, notes). Vertically resizable. */
export declare function Textarea(props: TextareaProps): JSX.Element;

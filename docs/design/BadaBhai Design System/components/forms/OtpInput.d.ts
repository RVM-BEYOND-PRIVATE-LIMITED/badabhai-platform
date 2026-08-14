import * as React from 'react';

/** Props for {@link OtpInput}. */
export interface OtpInputProps {
  /** Number of digit cells. @default 4 */
  length?: number;
  /** Controlled value (the digits entered so far). */
  value?: string;
  /** Called with the full string on every change. */
  onChange?: (value: string) => void;
  /** Focus the first cell on mount. */
  autoFocus?: boolean;
}

/** Phone + OTP is the worker login. Big mono cells, auto-advance, backspace nav. */
export declare function OtpInput(props: OtpInputProps): JSX.Element;

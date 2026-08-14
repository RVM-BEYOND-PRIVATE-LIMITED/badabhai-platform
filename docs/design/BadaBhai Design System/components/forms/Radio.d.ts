import * as React from 'react';

export interface RadioProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
}

/** Single-choice radio (share `name` across a group). */
export declare function Radio(props: RadioProps): JSX.Element;

import * as React from 'react';

export interface SwitchProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Label beside the toggle. */
  label?: React.ReactNode;
}

/** On/off toggle (turns green when on) — “show my phone”, alerts, masking prefs. */
export declare function Switch(props: SwitchProps): JSX.Element;

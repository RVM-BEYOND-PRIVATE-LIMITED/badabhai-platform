import * as React from 'react';

export interface TabItem {
  id: string;
  label: React.ReactNode;
  /** Optional Phosphor glyph name (filled when active). */
  icon?: string;
}

export interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  /** Tab definitions. */
  tabs: TabItem[];
  /** Selected tab id. */
  value?: string;
  /** Called with the new tab id. */
  onChange?: (id: string) => void;
  /** @default 'underline' */
  variant?: 'underline' | 'segmented';
}

/** Tabs — `underline` for page sections, `segmented` for filters & role views. */
export declare function Tabs(props: TabsProps): JSX.Element;

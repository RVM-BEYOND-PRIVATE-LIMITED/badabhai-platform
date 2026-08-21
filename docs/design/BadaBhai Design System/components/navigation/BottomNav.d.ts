import * as React from 'react';

export interface BottomNavItem {
  id: string;
  label: React.ReactNode;
  /** Phosphor glyph name (filled when active). */
  icon: string;
  /** Optional count badge (e.g. unread alerts). */
  badge?: React.ReactNode;
}

export interface BottomNavProps extends Omit<React.HTMLAttributes<HTMLElement>, 'onChange'> {
  items: BottomNavItem[];
  value?: string;
  onChange?: (id: string) => void;
}

/**
 * Worker-app bottom tab bar (Chat · Jobs · Resume · Profile). 48px targets.
 * @startingPoint section="Navigation" subtitle="Worker app bottom nav" viewport="700x120"
 */
export declare function BottomNav(props: BottomNavProps): JSX.Element;

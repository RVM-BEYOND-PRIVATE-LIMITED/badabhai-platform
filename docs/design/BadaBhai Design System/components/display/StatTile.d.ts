import * as React from 'react';

export interface StatTileProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Metric name. */
  label: string;
  /** Big value — rendered in Roboto Mono. */
  value: React.ReactNode;
  /** Phosphor glyph in the corner. */
  icon?: string;
  /** Delta text, e.g. `'+12% this week'`. */
  delta?: React.ReactNode;
  /** @default 'up' */
  deltaDir?: 'up' | 'down' | 'flat';
}

/**
 * Dashboard KPI tile for the payer web app (weekly paid unlocks, repeat-rate).
 * @startingPoint section="Display" subtitle="KPI stat tiles" viewport="700x180"
 */
export declare function StatTile(props: StatTileProps): JSX.Element;

import * as React from 'react';

export interface CardProps extends React.HTMLAttributes<HTMLElement> {
  /** @default 'default' */
  variant?: 'default' | 'raised' | 'flat' | 'outline' | 'ink';
  /** @default 'md' */
  padding?: 'none' | 'sm' | 'md' | 'lg';
  /** Adds hover-lift + pointer for clickable cards. */
  interactive?: boolean;
  /** Element/tag to render. @default 'div' */
  as?: any;
}

/** Warm white surface on paper — a hairline border + soft low shadow. */
export declare function Card(props: CardProps): JSX.Element;

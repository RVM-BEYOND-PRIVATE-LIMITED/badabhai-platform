import * as React from 'react';

export interface JobCardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Role title, e.g. “CNC Operator”. */
  title: string;
  /** Hiring company name. */
  company: string;
  /** Optional company logo URL. */
  companyLogo?: string;
  /** Show the verified seal next to the company. @default true */
  verified?: boolean;
  location?: string;
  shift?: string;
  /** Wage string, e.g. “₹22,000–28,000 / mo” (rendered in mono). */
  salary?: string;
  /** Short tag strings (skills, perks). */
  tags?: string[];
  /** Remaining applicant-quota spots (from the vacancy band). */
  vacanciesLeft?: number;
  /** Right action — apply. */
  onApply?: () => void;
  /** Left action — skip. */
  onSkip?: () => void;
}

/**
 * Swipe-to-apply job card: right = apply, left = skip, each swipe a learning signal.
 * @startingPoint section="Brand" subtitle="Swipe-to-apply job card" viewport="440x440"
 */
export declare function JobCard(props: JobCardProps): JSX.Element;

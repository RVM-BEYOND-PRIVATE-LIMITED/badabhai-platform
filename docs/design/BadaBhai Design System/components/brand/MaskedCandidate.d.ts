import * as React from 'react';

export interface MaskedCandidateProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Real name — only revealed (and un-blurred) when `masked` is false. */
  name?: string;
  trade?: string;
  experience?: string;
  location?: string;
  /** Verified seal. @default true */
  verified?: boolean;
  /** Masked = blurred name/photo + unlock CTA. @default true */
  masked?: boolean;
  /** Unlock price label. @default '₹40' */
  price?: string;
  /** Optional match/relevance badge text. */
  matchLabel?: string;
  /** Unlock handler (spends one credit). */
  onUnlock?: () => void;
}

/**
 * The payer demand-loop row: browse masked → unlock for ₹40 → contact.
 * @startingPoint section="Brand" subtitle="Masked candidate + unlock" viewport="560x110"
 */
export declare function MaskedCandidate(props: MaskedCandidateProps): JSX.Element;

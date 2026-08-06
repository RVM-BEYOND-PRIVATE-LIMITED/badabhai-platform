/** Shared shapes for the value normalizers. */

/** A normalized value plus the evidence span it came from. */
export interface NormalizedValue<T> {
  readonly value: T;
  /**
   * Character offsets into the source message. Feeds the parse call's provenance gate — the
   * gate that makes a hallucinated value impossible, because it has no span to point at.
   */
  readonly span: { readonly start: number; readonly end: number };
  /**
   * True when the negation engine VETOED a match that would otherwise have fired.
   * "abhi kaam nahi mil raha" must never become `availability: immediate`.
   *
   * Reported rather than swallowed: the caller decides. Answer capture drops a vetoed value,
   * but a diagnostic surface wants to know a cue was seen AND why it did not count.
   */
  readonly negationVetoed: boolean;
}

/** Monthly rupees. The interview never stores a raw string for a numeric field. */
export type MonthlyInr = number;

/** Availability, matching the shipped `DraftProfile` enum. */
export type Availability = "immediate" | "notice_period" | "not_looking" | "unknown";

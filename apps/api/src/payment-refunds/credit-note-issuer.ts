/**
 * #2750 item 10 — the GST credit note a refund needs (brief 4C.12; #2749 item 8 builds invoices).
 *
 * Owner ruling 2026-11-18: no refund goes out without its credit note. Invoices (#2749 part 4) are
 * not built yet (they wait on the seller's GSTIN), so the only issuer today is
 * {@link NoCreditNotes}: it reports `available: false`, and every refund route answers 503
 * `CREDIT_NOTES_UNAVAILABLE` before it reads anything.
 *
 * THE SEAM FOR #2749. The invoices work binds a real issuer to {@link CREDIT_NOTE_ISSUER} that
 * reports `available: true` and numbers a credit note for each refund inside the refund's own
 * transaction (writing `payment_refunds.credit_note_number`). Nothing else in the refund flow
 * changes when it lands.
 */
export interface CreditNoteIssuer {
  /** True once credit notes can be issued; until then no refund may be made. */
  readonly available: boolean;
}

/** The Nest token the refund service injects its issuer by. */
export const CREDIT_NOTE_ISSUER = Symbol("CREDIT_NOTE_ISSUER");

/** Today's issuer: credit notes do not exist yet, so refunds stay off. */
export class NoCreditNotes implements CreditNoteIssuer {
  readonly available = false;
}

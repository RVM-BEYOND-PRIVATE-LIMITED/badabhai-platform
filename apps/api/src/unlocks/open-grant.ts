/**
 * THE ONE DEFINITION OF AN OPEN CONTACT (#2747 item 6, ADR-0064 §3.4).
 *
 * Before #2747 an unlock was live for a fixed window (`UNLOCK_WINDOW_DAYS`) and three places spelled
 * that check on their own: the reveal, the relay resolution and the résumé route. They now all ask
 * {@link isOpenGrant}, and the résumé repository's SQL mirrors it.
 *
 *  - The `contact_rules` switch OFF for the company: open = `granted` or `revealed`, unexpired —
 *    exactly the old window.
 *  - ON: open = `granted` or `revealed`, whatever the date. A contact opened under the old window
 *    is honoured too ("past opens included"), with no write needed to read it.
 *
 * Writes keep "for good" true after a rollback. A grant made while the switch is on is stored with
 * {@link OPEN_FOR_GOOD_UNTIL}, and so is a lapsed grant the company re-opens (`POST /payer/unlocks`)
 * or reveals while it is on. Turning the switch off later never re-charges those.
 *
 * What still closes a contact is NOT here, because it is not a property of the grant row: the
 * worker's erasure (`unlocks.worker_id` is set null), the ADR-0031 deletion freeze, a suspension,
 * and his consent withdrawn. Every read path checks those itself, at read time.
 */

/** The far-future date an open-for-good grant stores. Shipped apps parse `expires_at` as a date. */
export const OPEN_FOR_GOOD_UNTIL = new Date("2099-12-31T23:59:59.000Z");

export interface GrantState {
  readonly status: string;
  readonly expiresAt: Date | null;
}

export function isOpenGrant(
  grant: GrantState,
  opts: { readonly openForGood: boolean; readonly now?: Date },
): boolean {
  if (grant.status !== "granted" && grant.status !== "revealed") return false;
  if (opts.openForGood) return true;
  const now = opts.now ?? new Date();
  return grant.expiresAt !== null && grant.expiresAt.getTime() > now.getTime();
}

/** A grant that is open by the rule but whose stored date has passed: a re-open stores the new date. */
export function needsOpenForGoodDate(grant: GrantState): boolean {
  return grant.expiresAt === null || grant.expiresAt.getTime() < OPEN_FOR_GOOD_UNTIL.getTime();
}

/**
 * The response's `open_until` (#2747): `null` means no end. Off, it is the window's end, the same
 * instant `expires_at` says.
 */
export function openUntilOf(openForGood: boolean, expiresAt: Date): string | null {
  return openForGood ? null : expiresAt.toISOString();
}

import { createHash } from "node:crypto";
import { isCanonicalUuid } from "../../common/uuid";

/**
 * #2755 item 8, metric group 10 — THE CALL LIST's rules, pure: when a company ran out, the order,
 * the keyset cursor, and the id of a logged call. The service reads the facts
 * (`numbers-calls.repository.ts`, `AdminEventsRepository`) and applies these; the unit tests feed
 * them by hand and the DB gate proves the whole list equals a hand-written SQL in the same order.
 */

/** The event the unlock path emits on the debit that spends a wallet's last credit. */
export const CREDITS_EXHAUSTED_EVENT = "payer.credits_exhausted";

/** A company whose usable balance is zero now, as the repository reads it. */
export interface ZeroBalanceCompany {
  readonly payerId: string;
  /** The `expires_at` of the newest lot that expired holding credits; null when none did. */
  readonly lastLotExpiryAt: Date | null;
}

/** A company on the call list: its id and the moment it ran out. */
export interface RanOutCompany {
  readonly payerId: string;
  readonly ranOutAt: Date;
}

/**
 * When a company ran out: the LATER of its last `payer.credits_exhausted` (its last credit spent)
 * and the `expires_at` of its newest lot that expired holding credits. Null when neither exists: a
 * company that never held a credit, or whose credits left another way, never ran out and is not
 * on the list.
 */
export function ranOutAt(exhaustedAt: Date | null, lastLotExpiryAt: Date | null): Date | null {
  if (exhaustedAt === null) return lastLotExpiryAt;
  if (lastLotExpiryAt === null) return exhaustedAt;
  return exhaustedAt.getTime() >= lastLotExpiryAt.getTime() ? exhaustedAt : lastLotExpiryAt;
}

/** The list's order: newest ran-out first, then the payer id descending (a total order). */
export function compareRanOut(a: RanOutCompany, b: RanOutCompany): number {
  const t = b.ranOutAt.getTime() - a.ranOutAt.getTime();
  if (t !== 0) return t;
  return a.payerId < b.payerId ? 1 : a.payerId > b.payerId ? -1 : 0;
}

/**
 * The call list, whole and in order: every zero-balance company with a ran-out moment, newest
 * first. `exhausted` maps a payer to its last `payer.credits_exhausted`.
 */
export function rankOutOfCredits(
  zero: readonly ZeroBalanceCompany[],
  exhausted: ReadonlyMap<string, Date>,
): RanOutCompany[] {
  const listed: RanOutCompany[] = [];
  for (const z of zero) {
    const at = ranOutAt(exhausted.get(z.payerId) ?? null, z.lastLotExpiryAt);
    if (at !== null) listed.push({ payerId: z.payerId, ranOutAt: at });
  }
  return listed.sort(compareRanOut);
}

// -----------------------------------------------------------------------------------------------
// The keyset cursor
// -----------------------------------------------------------------------------------------------

/** The last row of a page: the keyset the next page starts after. */
export interface OutOfCreditsCursor {
  readonly ranOutAt: string;
  readonly payerId: string;
}

/** Encode the cursor as an opaque base64url token. */
export function encodeOutOfCreditsCursor(row: RanOutCompany): string {
  return Buffer.from(
    JSON.stringify({ r: row.ranOutAt.toISOString(), p: row.payerId }),
    "utf8",
  ).toString("base64url");
}

/**
 * Decode a cursor token; null on ANY malformed input, so the caller serves the first page instead
 * of a 500 (a cursor is client-held state: truncated by a link shortener or hand-edited, sooner or
 * later). The time must parse and the id must be a canonical uuid.
 */
export function decodeOutOfCreditsCursor(token: string | undefined): OutOfCreditsCursor | null {
  if (!token) return null;
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as {
      r?: unknown;
      p?: unknown;
    };
    if (typeof parsed.r !== "string" || typeof parsed.p !== "string") return null;
    if (Number.isNaN(Date.parse(parsed.r))) return null;
    if (!isCanonicalUuid(parsed.p)) return null;
    // Postgres prints a uuid in lower case; the order compares the text.
    return { ranOutAt: parsed.r, payerId: parsed.p.toLowerCase() };
  } catch {
    return null;
  }
}

/** Is the row strictly after the cursor in the list's order? */
export function isAfterCursor(row: RanOutCompany, cursor: OutOfCreditsCursor): boolean {
  return (
    compareRanOut(
      { payerId: cursor.payerId, ranOutAt: new Date(Date.parse(cursor.ranOutAt)) },
      row,
    ) < 0
  );
}

/**
 * One keyset page of the ordered list: the rows after the cursor (all of them without one), at
 * most `limit`, and the cursor of the next page (null on the last; one row is over-read so a list
 * that ends exactly on a page boundary does not offer an empty next page).
 */
export function pageOutOfCredits(
  listed: readonly RanOutCompany[],
  cursor: OutOfCreditsCursor | null,
  limit: number,
): { rows: RanOutCompany[]; nextCursor: string | null } {
  const after = cursor === null ? listed : listed.filter((r) => isAfterCursor(r, cursor));
  const rows = after.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    rows,
    nextCursor: after.length > limit && last !== undefined ? encodeOutOfCreditsCursor(last) : null,
  };
}

// -----------------------------------------------------------------------------------------------
// The call log's idempotency
// -----------------------------------------------------------------------------------------------

/**
 * The id of the `credit_call_log` row an admin's request writes: a version-5-shaped uuid derived
 * from the admin and the request's Idempotency-Key. A retried POST derives the same id, so its
 * insert conflicts and nothing is written or emitted twice; the same key from another admin is a
 * different row.
 */
export function callIdForKey(adminId: string, idempotencyKey: string): string {
  const h = createHash("sha256")
    // `|` is outside the key's charset (`A-Z a-z 0-9 . _ : -`) and a uuid's, so the parts cannot
    // run into each other.
    .update(`credit_call_log|${adminId}|${idempotencyKey}`)
    .digest();
  h[6] = (h[6]! & 0x0f) | 0x50; // version 5
  h[8] = (h[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

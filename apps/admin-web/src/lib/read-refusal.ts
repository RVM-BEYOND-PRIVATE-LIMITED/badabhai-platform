import { uuidSchema } from "@badabhai/validators";
import { isAdminRequestError } from "./admin-http";

/**
 * What a failed read of a LIST refused, by the console's one rule (docs/design/NAVIGATION.md,
 * "A refused read is not an outage"):
 *   - "filters" — a 400 with a filter in the address. The API refuses a page cursor only when it is
 *     longer than any it issues (a malformed one falls back to page one), so with a filter set the
 *     filter is what was refused, and its first page would be refused too: the way out is clearing it.
 *   - "cursor"  — a 400 with no filter but a page cursor: the way out is the first page.
 *   - null      — anything else, a 400 with NOTHING in the address included: that cannot be the
 *     operator's, so it is an outage, and Retry is the way out.
 *
 * Repeating a refused request cannot succeed, so a refusal state never offers Retry.
 */
export type ReadRefusal = "filters" | "cursor" | null;

export function readRefusal(
  err: unknown,
  address: { filtered: boolean; cursor?: string | undefined },
): ReadRefusal {
  if (!isAdminRequestError(err) || err.status !== 400) return null;
  if (address.filtered) return "filters";
  if (address.cursor) return "cursor";
  return null;
}

/**
 * A filter value the server could have refused: present, and not one of the values the page's
 * own chips offer (`known`). A chip's value never can be — so with only known values in the
 * address, a 400 is the cursor's (or, with no cursor, ours), never "that reason is not one the
 * ledger records" (review of #2095: a valid reason beside an over-long cursor read exactly that).
 * Pass the result as `filtered` to {@link readRefusal}.
 */
export function isUnknownValue(value: string | undefined, known: readonly string[]): boolean {
  return value !== undefined && !known.includes(value);
}

/**
 * An id filter the server could have refused: present and not a uuid (every id filter on the
 * admin API is `.uuid()`). A well-formed id is never the refused part of a 400.
 */
export function isMalformedUuid(value: string | undefined): boolean {
  return value !== undefined && !uuidSchema.safeParse(value).success;
}

/**
 * A free-text filter the server could have refused: longer than the API's bound for it (the
 * events filters: `eventName` 128, `actorType` / `subjectType` 64). Within the bound, any text is
 * accepted — so it is never the refused part.
 */
export function isOverLength(value: string | undefined, max: number): boolean {
  return value !== undefined && value.length > max;
}

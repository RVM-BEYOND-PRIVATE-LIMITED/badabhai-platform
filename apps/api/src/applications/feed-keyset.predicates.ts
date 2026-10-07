import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/**
 * THE LEGACY FEED'S KEYSET (#1961, ADR-0052) — repository-layer SQL builders. They build SQL and
 * decide nothing: which key to resume after is the service's input.
 *
 * Both arms of the legacy feed (`jobs` by `created_at`, `job_postings` by `published_at`) serve
 * the one order `posted_at DESC, id ASC`, so one predicate serves both.
 */

/**
 * The position of one served row: `posted_at` as Postgres's microsecond UTC text (see
 * {@link postedKeyText}) and the row's id.
 */
export interface PostedKeysetPosition {
  postedKey: string;
  id: string;
}

/**
 * "Strictly after `after` in `posted_at DESC, id ASC`", i.e.
 * `posted_at < t OR (posted_at = t AND id > :id)`, written as
 * `posted_at <= t AND (posted_at < t OR id > :id)` so the leading conjunct is a plain range on
 * the sort column that `jobs_status_created_at_idx` / `job_postings_feed_idx` can bound.
 *
 * `undefined` (no predicate) on the first page, so that page's WHERE is exactly what it was.
 * The bound text is parsed by `::timestamptz` with no precision loss — a JS `Date` here would
 * truncate to milliseconds and drop or repeat rows that share a millisecond.
 */
export function postedKeysetAfter(
  postedColumn: AnyPgColumn,
  idColumn: AnyPgColumn,
  after: PostedKeysetPosition | undefined,
): SQL | undefined {
  if (after === undefined) return undefined;
  const t = sql`${after.postedKey}::timestamptz`;
  return sql`(${postedColumn} <= ${t} AND (${postedColumn} < ${t} OR ${idColumn} > ${after.id}::uuid))`;
}

/**
 * A `timestamptz` column as microsecond-precision UTC text (`2099-01-05T00:00:00.000000Z`) —
 * the exact value a keyset cursor must carry. `AT TIME ZONE 'UTC'` makes it independent of the
 * session's `TimeZone`.
 */
export function postedKeyText(postedColumn: AnyPgColumn): SQL<string> {
  return sql<string>`to_char(${postedColumn} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

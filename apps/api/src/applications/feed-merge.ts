import type { FeedJob, FeedPostingRow } from "./applications.repository";
import type { FeedItem } from "./applications.service";
import { toWorkerRoleKind } from "../common/worker-role-kind";

/**
 * THE LEGACY FEED'S CARD MAPPING AND ITS TWO-SOURCE MERGE (#1823, ADR-0049). Pure: no I/O,
 * no clock, no logger — every function here is a value in, a value out.
 *
 * Which table a card came from is the `FeedSource`. It never reaches the response: it only
 * selects the `feed.shown` envelope subject (`job` vs `job_posting`), which is what tells the
 * two id spaces apart on the spine. The values are the envelope's `subject_type` verbatim.
 */
export type FeedSource = "job" | "job_posting";

/** A card before its position is known. `rank` is the merged index, assigned last. */
export type UnrankedFeedItem = Omit<FeedItem, "rank">;

/** A card plus what the merge needs to order it and the emitter needs to subject it. */
export interface SourcedFeedItem {
  source: FeedSource;
  /** The merge key, as the database returned it. The card's `posted_at` is its ISO form. */
  postedAt: Date;
  card: UnrankedFeedItem;
}

/** A positioned card and the table it came from. */
export interface RankedFeedItem {
  source: FeedSource;
  item: FeedItem;
}

/**
 * An agency/seed `jobs` row as a card — the legacy mapping, moved here unchanged so the feed
 * has ONE mapper per source and no copy. Straight pass-through, nulls preserved (see
 * `FeedItem` for the honest-nulls doctrine): nothing here scores, defaults or drops a job.
 */
export function toSourcedFromJob(job: FeedJob): SourcedFeedItem {
  return {
    source: "job",
    postedAt: job.createdAt,
    card: {
      job_id: job.id,
      trade_key: job.tradeKey,
      title: job.title,
      city: job.city,
      area: job.area,
      min_experience_years: job.minExperienceYears,
      max_experience_years: job.maxExperienceYears,
      // ADR-0024 final addendum: pay band + shift join the PII-free set under the same
      // honest-nulls pass-through. Response-only — feed.shown is UNCHANGED.
      pay_min: job.payMin,
      pay_max: job.payMax,
      pay_type: job.payType,
      shift: job.shift,
      // Card content (#1561): the seed's own description/benefits/requirements, verbatim.
      description: job.description,
      benefits: job.benefits,
      requirements: job.requirements,
      needed_by: job.neededBy,
      posted_at: job.createdAt.toISOString(),
      // Card art (owner ruling 2026-10-05). Fail closed: a declared kind or null, nothing else.
      role_kind: toWorkerRoleKind(job.roleKind),
    },
  };
}

/**
 * A company posting as a card, on the SAME keys as a jobs card — no source key (ADR-0024
 * addendum for #1823).
 *
 *   - `trade_key` is `""`: a posting has no trade column, and the client renders no trade line
 *     for an empty key. Never an `mskill_*` id (vocabulary leak) and never `role_kind` (O6).
 *   - `role_kind` rides its OWN additive key, gated to the closed set or null, for the card's
 *     illustration (owner ruling 2026-10-05 supersedes O6's "not this phase").
 *   - `city` is `""` when the posting has no bucket: `FeedItem.city` is a string, the V1
 *     precedent. Never back-filled from `location_label`.
 *   - `posted_at` is `published_at` — ADR-0024's one key on both feed shapes.
 *
 * NULL when the row has no `published_at`: the query requires one, so this is a defensive
 * edge, and a card with no honest date is dropped (the caller logs it), never coerced.
 */
export function toSourcedFromPosting(row: FeedPostingRow): SourcedFeedItem | null {
  if (row.publishedAt === null) return null;
  return {
    source: "job_posting",
    postedAt: row.publishedAt,
    card: {
      job_id: row.id,
      trade_key: "",
      title: row.roleTitle,
      city: row.city ?? "",
      area: row.area,
      min_experience_years: row.minExperienceYears,
      max_experience_years: row.maxExperienceYears,
      pay_min: row.payMin,
      pay_max: row.payMax,
      pay_type: row.payType,
      shift: row.shift,
      description: row.description,
      benefits: row.benefits,
      requirements: row.requirements,
      needed_by: row.neededBy,
      posted_at: row.publishedAt.toISOString(),
      role_kind: toWorkerRoleKind(row.roleKind),
    },
  };
}

/**
 * The deck's one total order: `posted_at DESC`, then `id ASC`, then `job` before
 * `job_posting`. Ids compare as lowercase uuid strings, which is Postgres's uuid byte order,
 * so the tiebreak agrees with each arm's own `ORDER BY ... id ASC`.
 */
function precedes(a: SourcedFeedItem, b: SourcedFeedItem): boolean {
  const at = a.postedAt.getTime();
  const bt = b.postedAt.getTime();
  if (at !== bt) return at > bt;
  if (a.card.job_id !== b.card.job_id) return a.card.job_id < b.card.job_id;
  return a.source === "job" && b.source !== "job";
}

/**
 * Merge the two arms newest-first and keep the first `limit` (#1649 ruling; O5: no boost, no
 * per-company interleave, no score).
 *
 * A stable two-pointer merge over arms SQL has ALREADY sorted. It compares the two HEADS
 * only, so it never reorders rows within one arm — which is what makes JavaScript's
 * millisecond `Date` safe against Postgres's microsecond order inside an arm. The result is
 * exact: the top `limit` of (top `limit` of A ∪ top `limit` of B) is the top `limit` of
 * A ∪ B under one comparator. Neither input is mutated.
 */
export function mergeNewestFirst(
  jobs: readonly SourcedFeedItem[],
  postings: readonly SourcedFeedItem[],
  limit: number,
): SourcedFeedItem[] {
  const merged: SourcedFeedItem[] = [];
  let j = 0;
  let p = 0;
  while (merged.length < limit && (j < jobs.length || p < postings.length)) {
    const job = jobs[j];
    const posting = postings[p];
    if (job !== undefined && (posting === undefined || precedes(job, posting))) {
      merged.push(job);
      j += 1;
    } else if (posting !== undefined) {
      merged.push(posting);
      p += 1;
    }
  }
  return merged;
}

/** Position each card: `rank` is the 1-based index in the deck as served. */
export function rankFeed(items: readonly SourcedFeedItem[]): RankedFeedItem[] {
  return items.map((sourced, index) => ({
    source: sourced.source,
    item: { ...sourced.card, rank: index + 1 },
  }));
}

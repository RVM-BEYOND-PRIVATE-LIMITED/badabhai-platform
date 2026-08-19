import { formatCount } from "../lib/format";

/**
 * A count breakdown over a server-densified enum, rendered with the shipped `.funnel` rows.
 *
 * ── WHY IT REUSES `.funnel` RATHER THAN A NEW BLOCK ─────────────────────────────────────
 * The dashboard already renders "label … number … meta" rows for the conversion funnel, and a
 * second set of class names for the same shape is how two lists that should look identical
 * start drifting. Nothing here is funnel-specific; the block is a labelled figure list.
 *
 * ── THE ONE RULE THIS COMPONENT ENFORCES: THE `other` BUCKET ─────────────────────────────
 * The API densifies every closed enum — every member, zeros included — plus a trailing `other`
 * bucket holding stored values the enum does not name. Four of the five enums it densifies
 * (`workers.status`, `worker_profiles.profile_status`, `payers.role`, `payers.status`) are
 * plain `text` columns with NO database CHECK behind them, so a drifted value is a state a bad
 * write or an older deploy can actually reach — and the headline totals are summed from these
 * very buckets.
 *
 * So `other` is HIDDEN WHILE ZERO and LOUD WHEN NOT. Hiding a non-zero one would be this
 * portal concealing data corruption; showing a permanent "other: 0" row on five lists would
 * train an operator to skip the row that matters.
 */

/** The API's catch-all key — mirrored from `DASHBOARD_OTHER_BUCKET` in the dashboard DTO. */
export const OTHER_BUCKET_KEY = "other";

export interface Bucket {
  key: string;
  count: number;
}

/** `job_posting` → `job posting`. Enum members are snake_case machine labels. */
function bucketLabel(key: string): string {
  return key.replace(/_/g, " ");
}

export function BucketList({
  buckets,
  labelledBy,
}: {
  buckets: readonly Bucket[];
  /** Id of the heading this list belongs to, so the list is announced with its section. */
  labelledBy?: string;
}) {
  const rows = buckets.filter((b) => b.key !== OTHER_BUCKET_KEY || b.count > 0);

  if (rows.length === 0) {
    return <p className="empty">No breakdown was returned for this figure.</p>;
  }

  return (
    <ul className="funnel" aria-labelledby={labelledBy}>
      {rows.map((b) => {
        const isOther = b.key === OTHER_BUCKET_KEY;
        return (
          <li className="funnel__row" key={b.key}>
            <span className="funnel__label">
              {isOther ? "other (not a known value)" : bucketLabel(b.key)}
            </span>
            <span className="funnel__nums">
              <span className="funnel__distinct">{formatCount(b.count)}</span>
              {isOther ? (
                <span className="funnel__events">
                  stored values this enum does not name — worth investigating
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

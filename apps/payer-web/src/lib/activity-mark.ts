/**
 * The company-side "not recently active" mark (#2753 item 7).
 *
 * The API sends `notRecentlyActive` on applicant and search rows ONLY while
 * `WORKER_ACTIVITY_ENABLED` is on; absent means no mark. The server decides the
 * mark — the client never derives it from `lastActiveOn` or any clock — and a
 * mark never hides or re-sorts a worker (owner's default: only mark).
 *
 * One label, shared by the applicant card and the all-candidates card so the
 * two surfaces cannot drift.
 */
export const NOT_RECENTLY_ACTIVE_LABEL = "Not recently active";

/// Company-side "not recently active" mark (#2753 item 7).
///
/// The API adds `notRecentlyActive` to applicant and search rows only while
/// `WORKER_ACTIVITY_ENABLED` is on. It is a MARK, never a filter: the server's
/// order is untouched and no worker is hidden. One label, shared by the
/// applicant card and the all-candidates card.
const String kNotRecentlyActiveLabel = 'Not recently active';

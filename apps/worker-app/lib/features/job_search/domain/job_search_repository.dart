import 'job_search_item.dart';

/// Search boundary for the Indeed-style job search (`GET /jobs/search`).
/// Implementations read the worker's session token (never the widget) and throw
/// a [Failure] on error — notably [ConsentRequiredFailure] on a 403 — so the
/// cubit can surface the honest reason and route consent the same way the swipe
/// feed does.
///
/// Each argument is OPTIONAL: an empty title/city/state means "do not narrow on
/// that dimension", and the implementation omits it from the query (mirroring
/// how `getFeed` builds its Uri). [page] is 1-based.
abstract interface class JobSearchRepository {
  Future<JobSearchPage> searchJobs({
    String? q,
    String? city,
    String? state,
    int limit,
    int page,
  });
}

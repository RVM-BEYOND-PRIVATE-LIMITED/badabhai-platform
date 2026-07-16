import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/swipe_repository.dart';

class SwipeRepositoryImpl implements SwipeRepository {
  SwipeRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  String _requireToken() {
    final String? token = _session.sessionToken;
    if (token == null || token.isEmpty) throw const UnauthorizedFailure();
    return token;
  }

  /// The deck's feed, with the worker's ALREADY-APPLIED jobs excluded (WA-1).
  ///
  /// `GET /feed` is deliberately liberal server-side: it returns every open job
  /// in a fixed order and does NOT exclude jobs this worker has already decided.
  /// The server records decisions as an UPSERT keyed on (worker_id, job_id)
  /// with last-write-wins (ADR-0009 §2) — so if the deck re-serves an
  /// already-APPLIED job and the worker swipes it away ("seen it, skip"), the
  /// skip silently OVERWRITES the applied row and the job vanishes from Applied
  /// jobs. Session after session that collapsed the Applied list down to only
  /// the most recent apply.
  ///
  /// The client-side guard: fetch the worker's own decisions
  /// (`GET /workers/me/applications` — same guards as `/feed`) alongside the
  /// feed and drop every job with `action == 'applied'` before the deck ever
  /// sees it. APPLIED ONLY, deliberately: SKIPPED jobs re-serve exactly as
  /// today, preserving ADR-0009's mind-change path (skip → later apply) — the
  /// deck is the only surface a worker can re-decide on, and a skip→apply flip
  /// is a safe upsert (it upgrades the row, destroying nothing). Whether skips
  /// should cool down / never resurface is a product call that belongs to the
  /// server-side follow-up. FAIL-CLOSED: if the decisions read fails we surface
  /// the failure (error view + retry) rather than silently serving a deck that
  /// can destroy applied state.
  ///
  /// NOTE: this client-side filter is an interim guard, and a server-side
  /// exclusion on `/feed` is REQUIRED (not nice-to-have): the feed's LIMIT is
  /// applied BEFORE this filter, so a worker whose applies fill the server page
  /// starves the deck, and the decisions read is itself capped — both are
  /// recorded as a mandatory backend follow-up.
  @override
  Future<List<FeedItem>> getFeed() async {
    final String token = _requireToken();
    try {
      // Parallel — one round-trip's latency on a slow link, and Future.wait
      // rethrows the ORIGINAL error so mapError still sees the ApiException.
      final List<Object> results = await Future.wait(<Future<Object>>[
        _api.getFeed(authToken: token),
        _api.getMyApplications(authToken: token),
      ]);
      final List<FeedItem> feed = results[0] as List<FeedItem>;
      final List<AppliedJob> decisions = results[1] as List<AppliedJob>;
      // APPLIED only (see doc above) — skipped jobs stay re-decidable.
      final Set<String> appliedJobIds = decisions
          .where((AppliedJob a) => a.action == 'applied')
          .map((AppliedJob a) => a.jobId)
          .toSet();
      return feed
          .where((FeedItem job) => !appliedJobIds.contains(job.jobId))
          .toList();
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> applyToJob(String jobId, {int? rank}) async {
    final String token = _requireToken();
    try {
      await _api.applyToJob(jobId, authToken: token, rank: rank);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> skipJob(String jobId, {required String reason}) async {
    final String token = _requireToken();
    try {
      await _api.skipJob(jobId, authToken: token, reason: reason);
    } catch (error) {
      throw mapError(error);
    }
  }

}

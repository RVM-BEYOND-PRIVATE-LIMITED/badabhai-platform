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

  /// The deck's feed, with the worker's ALREADY-DECIDED jobs excluded (WA-1).
  ///
  /// `GET /feed` is deliberately liberal server-side: it returns every open job
  /// in a fixed order and does NOT exclude jobs this worker has already applied
  /// to or skipped. The server records decisions as an UPSERT keyed on
  /// (worker_id, job_id) with last-write-wins (ADR-0009 §2) — so if the deck
  /// re-serves an already-APPLIED job and the worker swipes it away ("seen it,
  /// skip"), the skip silently OVERWRITES the applied row and the job vanishes
  /// from Applied jobs. Session after session that collapsed the Applied list
  /// down to only the most recent apply.
  ///
  /// The fix is at this layer: fetch the worker's own decisions
  /// (`GET /workers/me/applications` — same guards as `/feed`) alongside the
  /// feed and drop every decided job before the deck ever sees it. FAIL-CLOSED:
  /// if the decisions read fails we surface the failure (error view + retry)
  /// rather than silently serving a deck that can destroy applied state.
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
      // BOTH actions are "decided" — a skipped job must not resurface either.
      final Set<String> decidedJobIds =
          decisions.map((AppliedJob a) => a.jobId).toSet();
      return feed
          .where((FeedItem job) => !decidedJobIds.contains(job.jobId))
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

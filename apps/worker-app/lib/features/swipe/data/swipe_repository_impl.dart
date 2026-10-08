import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/job_detail.dart';
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
  ///
  /// PAGING (#2068, ADR-0052): [cursor] is the previous page's
  /// [FeedPage.nextCursor], handed back to the server untouched; null is page 1.
  /// The response's own `next_cursor` rides back on the [FeedPage] — an absent
  /// key reads as null, so an older API build (or a rollback of PR #2067) simply
  /// serves one page, exactly as before.
  @override
  Future<FeedPage> getFeed({
    String? tradeKey,
    String? city,
    String? shift,
    int? payMin,
    String? cursor,
  }) async {
    final String token = _requireToken();
    try {
      return await _api.getFeed(
        authToken: token,
        tradeKey: tradeKey,
        city: city,
        shift: shift,
        payMin: payMin,
        cursor: cursor,
      );
    } on ApiException catch (error) {
      // A 400 that NAMES the cursor is not a worker-visible error: the position
      // we sent is void (malformed, or minted for a feed order a flag flip
      // replaced), and the only valid move is to start the deck again from page
      // 1. Typed so the bloc can do that silently; every other 400 keeps its
      // generic [InvalidRequestFailure] mapping.
      if (_namesCursor(error)) throw const FeedCursorRejectedFailure();
      throw mapError(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  /// The FULL posting for one job — the same `GET /jobs/:jobId` the detail
  /// screen reads, exposed here so a feed CARD can be enriched through the
  /// SAME client/session seam (and the same mock in tests). Errors map like
  /// every other call; the card treats one as "no extra facts".
  @override
  Future<JobDetail> jobDetail(String jobId) async {
    final String token = _requireToken();
    try {
      return await _api.jobDetail(jobId, authToken: token);
    } catch (error) {
      throw mapError(error);
    }
  }

  @override
  Future<void> applyToJob(String jobId, {int? rank, String? sourceSurface}) async {
    final String token = _requireToken();
    try {
      await _api.applyToJob(
        jobId,
        authToken: token,
        rank: rank,
        sourceSurface: sourceSurface ?? 'feed',
      );
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

  /// Whether a failed `/feed` response blames the `cursor` param (#2068).
  ///
  /// The server's validation 400 is `{message: "Validation failed", issues:
  /// [{path: "cursor", message}]}` — and app-wide `AllExceptionsFilter` nests
  /// that payload under `error`, so the key is read in BOTH places: `error`
  /// first (the real wire shape) and the top level second (the shape #2068
  /// quotes, and any future envelope). Reads the PATH only: the two messages
  /// ("cursor is malformed", "cursor was issued for a different feed order…")
  /// are server copy and must not become a client-side match key.
  static bool _namesCursor(ApiException error) {
    if (error.statusCode != 400) return false;
    final Map<String, dynamic>? body = error.body;
    if (body == null) return false;
    final dynamic nested = body['error'];
    final dynamic nestedIssues =
        nested is Map<String, dynamic> ? nested['issues'] : null;
    return _issuesNameCursor(nestedIssues) || _issuesNameCursor(body['issues']);
  }

  /// True when a Zod `issues` list has an entry whose `path` is the cursor
  /// param. Defensive about every level — a garbage error body must not throw
  /// over the top of the failure it describes.
  static bool _issuesNameCursor(dynamic issues) {
    if (issues is! List<dynamic>) return false;
    return issues.whereType<Map<String, dynamic>>().any(
          (Map<String, dynamic> issue) => issue['path'] == 'cursor',
        );
  }
}

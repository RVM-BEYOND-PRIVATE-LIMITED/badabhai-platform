import '../../../core/api/api_models.dart';
import 'job_detail.dart';

/// Feed boundary for the alpha swipe-to-apply flow. Implementations read the
/// worker's session token (never the widget) and throw a [Failure] on error —
/// notably [ConsentRequiredFailure] on a 403 so the bloc can route to consent.
abstract interface class SwipeRepository {
  /// One PAGE of the deck (#2068): the cards plus the opaque cursor for the page
  /// after them. [cursor] is the previous page's [FeedPage.nextCursor], sent
  /// back untouched; null asks for page 1. A cursor the server refuses throws
  /// [FeedCursorRejectedFailure] — the caller restarts from page 1 instead of
  /// surfacing it.
  Future<FeedPage> getFeed({
    String? tradeKey,
    String? city,
    String? shift,
    int? payMin,
    String? cursor,
  });

  /// The FULL worker-visible posting (`GET /jobs/:jobId`) — the same columns
  /// the feed row now carries (needed-by, description, requirements, benefits,
  /// pay/shift/experience), read fresh and in full. Used to ENRICH a feed card;
  /// a failure is non-fatal, because the card already renders the feed's own
  /// copy of those facts.
  Future<JobDetail> jobDetail(String jobId);

  /// Records the apply. [sourceSurface] is the API enum for WHERE the apply was
  /// taken from ('feed' | 'search' | 'share' | 'other'); null defaults to 'feed'.
  /// A search-initiated apply MUST pass 'search' so analytics do not credit the
  /// feed (#1906).
  Future<void> applyToJob(String jobId, {int? rank, String? sourceSurface});

  Future<void> skipJob(String jobId, {required String reason});

}

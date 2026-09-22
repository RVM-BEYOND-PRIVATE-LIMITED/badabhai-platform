import '../../../core/api/api_models.dart';
import 'job_detail.dart';

/// Feed boundary for the alpha swipe-to-apply flow. Implementations read the
/// worker's session token (never the widget) and throw a [Failure] on error —
/// notably [ConsentRequiredFailure] on a 403 so the bloc can route to consent.
abstract interface class SwipeRepository {
  Future<List<FeedItem>> getFeed({
    String? tradeKey,
    String? city,
    String? shift,
    int? payMin,
  });

  /// The FULL worker-visible posting (`GET /jobs/:jobId`) — the same columns
  /// the feed row now carries (needed-by, description, requirements, benefits,
  /// pay/shift/experience), read fresh and in full. Used to ENRICH a feed card;
  /// a failure is non-fatal, because the card already renders the feed's own
  /// copy of those facts.
  Future<JobDetail> jobDetail(String jobId);

  Future<void> applyToJob(String jobId, {int? rank});

  Future<void> skipJob(String jobId, {required String reason});

}

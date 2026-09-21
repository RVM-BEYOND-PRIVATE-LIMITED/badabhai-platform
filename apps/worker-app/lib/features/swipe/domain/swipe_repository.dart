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

  /// The FULL worker-visible posting (`GET /jobs/:jobId`) — carries the real
  /// fields the feed card lacks (needed-by, description, requirements,
  /// benefits, and the posting's own pay/shift/experience). Used to ENRICH a
  /// feed card; a failure is non-fatal to the card (it keeps its feed facts).
  Future<JobDetail> jobDetail(String jobId);

  Future<void> applyToJob(String jobId, {int? rank});

  Future<void> skipJob(String jobId, {required String reason});

}

import '../../../core/api/api_models.dart';

/// Feed boundary for the alpha swipe-to-apply flow. Implementations read the
/// worker's session token (never the widget) and throw a [Failure] on error —
/// notably [ConsentRequiredFailure] on a 403 so the bloc can route to consent.
abstract interface class SwipeRepository {
  Future<List<FeedItem>> getFeed();

  Future<void> applyToJob(String jobId, {int? rank});

  Future<void> skipJob(String jobId, {required String reason});
}

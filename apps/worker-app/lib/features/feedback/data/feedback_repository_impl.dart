import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/feedback_category.dart';
import '../domain/feedback_repository.dart';
import '../domain/screen_context.dart';

/// Real feedback repository (follows the auth/name/chat real-repo pattern: ctor
/// takes the [ApiClient] + [SessionRepository], not a hardcoded mock).
///
/// Reads the worker's bearer token off the session and posts their feedback to
/// the API, which records it for the admin console. The message is the worker's
/// own free text; it passes through here once and is never retained or logged.
class FeedbackRepositoryImpl implements FeedbackRepository {
  FeedbackRepositoryImpl(this._api, this._session);

  final ApiClient _api;
  final SessionRepository _session;

  @override
  Future<void> submit({
    required String message,
    FeedbackCategory? category,
    String? screen,
  }) async {
    final String? token = _session.sessionToken;
    if (token == null) {
      throw const UnauthorizedFailure();
    }
    try {
      await _api.submitFeedback(
        authToken: token,
        message: message,
        category: category?.wire,
        // THE wire boundary for the screen context: normalize here, not at the
        // call site, so every caller present and future gets a route PATTERN and
        // no identifier can reach the endpoint by way of a screen that forgot.
        screen: normalizeScreenContext(screen),
      );
    } catch (error) {
      throw mapError(error);
    }
  }
}

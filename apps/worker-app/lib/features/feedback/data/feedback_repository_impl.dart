import '../../../core/api/api_client.dart';
import '../../../core/error/failure.dart';
import '../../../core/error/failure_mapper.dart';
import '../../../core/session/session_repository.dart';
import '../domain/feedback_category.dart';
import '../domain/feedback_repository.dart';

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
      );
    } catch (error) {
      throw mapError(error);
    }
  }
}

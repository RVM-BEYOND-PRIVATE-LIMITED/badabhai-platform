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
    List<String> attachmentPaths = const <String>[],
  }) async {
    final String? token = _session.sessionToken;
    if (token == null) {
      throw const UnauthorizedFailure();
    }
    // THE wire boundary for the screen context: normalize here, not at the call
    // site, so every caller present and future gets a route PATTERN and no
    // identifier can reach the endpoint by way of a screen that forgot.
    final String? normalized = normalizeScreenContext(screen);
    // An empty list becomes ABSENT on the wire (the ApiClient omits the key), so
    // a no-image submission is byte-identical to a released build — which is what
    // keeps the retry-without-`screen` path below safe.
    final List<String>? paths =
        attachmentPaths.isEmpty ? null : attachmentPaths;
    try {
      await _api.submitFeedback(
        authToken: token,
        message: message,
        category: category?.wire,
        screen: normalized,
        attachmentPaths: paths,
      );
    } on ApiException catch (error) {
      // `screen` is a NEW key on a DTO the server declares `.strict()`, so an API
      // that predates it answers 400 `unrecognized_keys` — measured against the
      // deployed schema. The worker cannot act on that: the screen renders it as
      // the persistent "change what you sent" panel, and nothing they can type
      // removes the key. Their whole report would be unsendable until the API
      // ships.
      //
      // So the OPTIONAL field degrades like one. This is telemetry the worker
      // never filled in; it is never worth their paragraph. Retried once without
      // it, and only when there was one to drop — a 400 with no `screen` in the
      // body is the server's answer about the MESSAGE and is surfaced as-is.
      if (error.statusCode == 400 && normalized != null) {
        try {
          await _api.submitFeedback(
            authToken: token,
            message: message,
            category: category?.wire,
            // The images already uploaded — only `screen` is being dropped as
            // the unknown key, so the attachments stay on the retry. Safe to keep:
            // a non-empty `paths` means the mint endpoint answered, and that same
            // deploy accepts `attachment_paths` on submit (the two ship together),
            // so re-sending them cannot itself re-trigger an unknown-key 400.
            attachmentPaths: paths,
          );
          return;
        } catch (retried) {
          throw mapError(retried);
        }
      }
      throw mapError(error);
    } catch (error) {
      throw mapError(error);
    }
  }
}

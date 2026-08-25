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
  Future<FeedbackSubmitOutcome> submit({
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
    final String? categoryWire = category?.wire;
    // An empty list becomes ABSENT on the wire (the ApiClient omits the key), so
    // a no-image submission is byte-identical to a released build — which is what
    // keeps the two degrade paths below safe.
    final List<String>? paths =
        attachmentPaths.isEmpty ? null : attachmentPaths;
    try {
      await _api.submitFeedback(
        authToken: token,
        message: message,
        category: categoryWire,
        screen: normalized,
        attachmentPaths: paths,
      );
      return FeedbackSubmitOutcome.sent;
    } on ApiException catch (error) {
      // DEGRADE A — `screen` is a NEW key on a DTO the server declares
      // `.strict()`, so an API that predates it answers 400 `unrecognized_keys`.
      // The worker cannot act on that: the screen renders a 400 as the persistent
      // "change what you sent" panel, and nothing they can type removes the key.
      //
      // So the OPTIONAL field degrades like one — telemetry they never filled in,
      // never worth their paragraph. Retried once without it, only when there was
      // one to drop; a 400 with no `screen` in the body is the server's answer
      // about the MESSAGE and is surfaced as-is.
      if (error.statusCode == 400 && normalized != null) {
        return _retryWithoutScreen(
          token: token,
          message: message,
          categoryWire: categoryWire,
          paths: paths,
        );
      }
      // DEGRADE B — the submit CARRIED attachment paths and the server 5xx'd on
      // it (e.g. the attachment column is not on this deploy, so the INSERT that
      // names it 500s). Drop the images and re-send the text so the report always
      // lands. Safe against a double-store: a 5xx means that insert AND its event
      // rolled back atomically, so nothing was written — the resend is the only
      // record. Only when there were attachments to drop; a 5xx with none is a
      // real outage and is surfaced as-is (never a silent drop of the message).
      if (error.statusCode >= 500 && paths != null) {
        return _retryWithoutAttachments(
          token: token,
          message: message,
          categoryWire: categoryWire,
          screen: normalized,
        );
      }
      throw mapError(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  /// DEGRADE A retry: re-send without `screen`, keeping the message, category and
  /// the already-uploaded attachment paths.
  ///
  /// The images stay because only `screen` was the unknown key. But this deploy
  /// can still be unable to STORE those paths (the #1191 column gap), so this
  /// retry composes with DEGRADE B: a 5xx here, with attachments still attached,
  /// drops them and re-sends the text one last time.
  Future<FeedbackSubmitOutcome> _retryWithoutScreen({
    required String token,
    required String message,
    required String? categoryWire,
    required List<String>? paths,
  }) async {
    try {
      await _api.submitFeedback(
        authToken: token,
        message: message,
        category: categoryWire,
        attachmentPaths: paths,
      );
      return FeedbackSubmitOutcome.sent;
    } on ApiException catch (error) {
      if (error.statusCode >= 500 && paths != null) {
        // `screen` was already the rejected key, so it is dropped here too.
        return _retryWithoutAttachments(
          token: token,
          message: message,
          categoryWire: categoryWire,
          screen: null,
        );
      }
      throw mapError(error);
    } catch (error) {
      throw mapError(error);
    }
  }

  /// DEGRADE B retry: re-send the SAME message WITHOUT `attachment_paths` (byte-
  /// identical to a no-image submission), keeping [screen] when it survived. A
  /// success here means the text landed but the photos did not —
  /// [FeedbackSubmitOutcome.sentWithoutAttachments]; a failure is a real outage
  /// and is thrown so the worker's text is preserved for a manual retry.
  Future<FeedbackSubmitOutcome> _retryWithoutAttachments({
    required String token,
    required String message,
    required String? categoryWire,
    required String? screen,
  }) async {
    try {
      await _api.submitFeedback(
        authToken: token,
        message: message,
        category: categoryWire,
        screen: screen,
      );
      return FeedbackSubmitOutcome.sentWithoutAttachments;
    } catch (error) {
      throw mapError(error);
    }
  }
}

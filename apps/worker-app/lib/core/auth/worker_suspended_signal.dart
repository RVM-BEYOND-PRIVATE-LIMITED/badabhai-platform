import 'dart:async';

/// The RESERVED wire code for a suspended worker account (backend #2562/#2679).
///
/// Every worker-facing route answers a suspended account with HTTP 403 and this
/// exact `code`, so the app can tell it apart from the ordinary consent gate:
/// `403 WORKER_ACCOUNT_SUSPENDED` is NOT "accept consent", and routing it there
/// would trap the worker in the consent/sign-in loop this feature exists to end.
const String kWorkerAccountSuspendedCode = 'WORKER_ACCOUNT_SUSPENDED';

/// A parsed suspended-account refusal.
///
/// [restrictedToken] is OPTIONAL and deliberately short-lived: a backend that
/// includes #2679 may include it in the 403 body so the worker can still exercise
/// their DPDP exits (delete account / withdraw consent). It MUST NEVER be used
/// as a session bearer, persisted, or handed to push registration. Every other
/// call site must use it only for the two DPDP routes named in the issue.
class WorkerSuspension {
  const WorkerSuspension({this.restrictedToken});

  final String? restrictedToken;

  @override
  bool operator ==(Object other) =>
      other is WorkerSuspension && other.restrictedToken == restrictedToken;

  @override
  int get hashCode => restrictedToken.hashCode;

  @override
  String toString() =>
      'WorkerSuspension(restrictedToken: ${restrictedToken == null ? 'none' : 'present'})';
}

/// True IFF a response is a suspended-account refusal: HTTP **403** AND the
/// reserved code. The code is accepted from the TOP-LEVEL body or the API's
/// `{ error: { code } }` envelope, because the real wire nests it under `error`.
///
/// Returns the parsed [WorkerSuspension] (so callers can read a restricted token
/// when the backend supplied one) or null for every other response — including
/// a bare 403 and the normal consent-gate 403.
WorkerSuspension? parseWorkerSuspension(
  int statusCode,
  Map<String, dynamic>? body,
) {
  if (statusCode != 403 || body == null) return null;
  final Object? error = body['error'];
  final Map<String, dynamic>? envelope = error is Map<String, dynamic>
      ? error
      : null;
  final Object? code = body['code'] ?? envelope?['code'];
  if (code != kWorkerAccountSuspendedCode) return null;
  final Object? rawToken =
      body['restricted_token'] ?? envelope?['restricted_token'];
  final String? token = rawToken is String && rawToken.isNotEmpty
      ? rawToken
      : null;
  return WorkerSuspension(restrictedToken: token);
}

/// An app-scoped one-way signal that the backend refused this worker because the
/// account is suspended.
///
/// Fired by both HTTP seams ([ApiClient] and [AuthedClient]) so EVERY refusal
/// point — phone-code verify, PIN unlock, token refresh, and any generic
/// authenticated request — reaches the same app-level destination. The app root
/// subscribes, clears local session state, and the router shows one suspended
/// screen. The screen never loops back into consent or sign-in.
class WorkerSuspendedSignal {
  final StreamController<WorkerSuspension> _controller =
      StreamController<WorkerSuspension>.broadcast();

  /// Emits on every suspended refusal. Late subscribers still see subsequent
  /// events; the app root is the long-lived listener.
  Stream<WorkerSuspension> get stream => _controller.stream;

  /// Signals a suspended account. Safe to call repeatedly (parallel in-flight
  /// requests); the session manager collapses repeats.
  void fire(WorkerSuspension suspension) {
    if (!_controller.isClosed) _controller.add(suspension);
  }

  void dispose() => _controller.close();
}

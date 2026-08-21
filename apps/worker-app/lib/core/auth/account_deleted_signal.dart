import 'dart:async';

/// The RESERVED wire code for "a valid worker token resolved a worker whose row
/// no longer exists" (backend: `WORKER_ACCOUNT_DELETED_CODE`). One definition
/// shared by both HTTP seams and their tests so the client keys on it exactly.
const String kWorkerAccountDeletedCode = 'WORKER_ACCOUNT_DELETED';

/// True IFF a response is the RESERVED account-deleted signal: HTTP **410** AND a
/// `code == WORKER_ACCOUNT_DELETED`.
///
/// The code is read from EITHER the top-level body OR the API's `{ error: { code
/// } }` envelope — the global `AllExceptionsFilter` nests every thrown exception
/// under `error`, so on the real wire the code lives at `body['error']['code']`,
/// NOT top-level. Accepting both shapes makes the trigger robust to the envelope
/// (and to any future flattening) without ever widening it: BOTH the 410 status
/// AND the exact code are still required, so no generic error — a 500, a
/// timeout, a bare 410, a different code, a 401 — can ever cause a false
/// destructive logout. This is the single source of truth for the trigger.
bool isWorkerAccountDeletedResponse(int statusCode, Map<String, dynamic>? body) {
  if (statusCode != 410 || body == null) return false;
  if (body['code'] == kWorkerAccountDeletedCode) return true;
  final Object? error = body['error'];
  return error is Map && error['code'] == kWorkerAccountDeletedCode;
}

/// A one-way "the backend says this worker's account no longer exists — send
/// them back to a fresh login" signal.
///
/// Fired by the HTTP seams ([ApiClient] / [AuthedClient]) when a call made with a
/// VALID worker token comes back on the RESERVED account-deleted contract: HTTP
/// 410 Gone with body `{ "code": "WORKER_ACCOUNT_DELETED" }`. The app root
/// subscribes to [stream], shows a SINGLE non-dismissible dialog, and hard-logs-
/// out on OK.
///
/// This is deliberately DISTINCT from [ReauthSignal]. That one is a recoverable
/// "your session expired, log in again" nudge; here the worker's row is GONE
/// server-side, so the only honest outcome is a full wipe + return to phone
/// login — never a silent retry. The two never share a code path so a routine
/// refresh failure can never masquerade as account deletion (or the reverse).
///
/// Implemented over a broadcast [Stream] so multiple listeners can react and a
/// late subscriber doesn't block emission. App-scoped (one instance via DI);
/// call [dispose] only at app teardown.
class AccountDeletedSignal {
  final StreamController<void> _controller =
      StreamController<void>.broadcast();

  /// Emits whenever the backend reports the worker's account has been deleted.
  Stream<void> get stream => _controller.stream;

  /// Signals that the account is gone. Safe to call repeatedly (parallel 410s
  /// from concurrent in-flight calls); the app-root listener debounces to a
  /// single dialog on its side.
  void fire() {
    if (!_controller.isClosed) _controller.add(null);
  }

  void dispose() => _controller.close();
}

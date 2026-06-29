import 'dart:async';

/// A one-way "this session is dead, send the worker back to login" signal.
///
/// Fired by the auth interceptor when a token refresh fails unrecoverably
/// (refresh token missing/expired, `REQUIRES_OTP`, `REFRESH_REUSE_DETECTED`, or
/// `DEVICE_REVOKED`). PASS 2's router subscribes to [stream] and navigates to the
/// login route; PASS 1 only emits.
///
/// Implemented over a broadcast [Stream] so multiple listeners (router + any
/// session manager) can react, and late subscribers don't block emission. It is
/// app-scoped (one instance via DI); call [dispose] only at app teardown.
class ReauthSignal {
  final StreamController<void> _controller =
      StreamController<void>.broadcast();

  /// Emits whenever the session must be re-established via a fresh OTP login.
  Stream<void> get stream => _controller.stream;

  /// Signals that re-authentication is required. Safe to call repeatedly; the
  /// router debounces navigation on its side.
  void requireReauth() {
    if (!_controller.isClosed) _controller.add(null);
  }

  void dispose() => _controller.close();
}

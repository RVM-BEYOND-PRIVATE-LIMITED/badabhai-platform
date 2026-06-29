import 'package:equatable/equatable.dart';

/// The canonical set of auth error `code` strings the API returns in its error
/// body (`{ "code": "PIN_LOCKED", ... }`). Logic keys off these constants — never
/// off the human-readable `message`, which is for display only.
///
/// ASSUMED CONTRACT — reconcile with backend. These strings are the assumed
/// wire values for the (not-yet-shipped) /auth/* error bodies. If the backend
/// settles on different strings, change them HERE only.
abstract final class AuthErrorCode {
  /// Too many bad PIN attempts — locked for `retryAfter`.
  static const String pinLocked = 'PIN_LOCKED';

  /// Wrong PIN — `attemptsLeft` tries remain before a lock.
  static const String pinInvalid = 'PIN_INVALID';

  /// The server wants a fresh OTP login (e.g. PIN reset path).
  static const String requiresOtp = 'REQUIRES_OTP';

  /// A rotated refresh token was reused — treated as a compromise; force re-auth.
  static const String refreshReuseDetected = 'REFRESH_REUSE_DETECTED';

  /// OTP requested too often.
  static const String otpRateLimited = 'OTP_RATE_LIMITED';

  /// Wrong / expired OTP code.
  static const String otpInvalid = 'OTP_INVALID';

  /// This device's session was revoked from another device.
  static const String deviceRevoked = 'DEVICE_REVOKED';

  /// The access (or refresh) token is expired — drives the reactive refresh.
  static const String tokenExpired = 'TOKEN_EXPIRED';

  /// Synthetic (client-side) code for a transport/offline failure — never sent by
  /// the server, emitted by the interceptor when a request can't reach the host.
  static const String network = 'NETWORK';

  /// Synthetic (client-side) catch-all when the server gives no parseable code.
  static const String unknown = 'UNKNOWN';

  /// The codes that mean "this device must log in again from scratch": clear the
  /// secure store and bounce to OTP. The interceptor uses this set to decide when
  /// to fire the reauth signal after a failed refresh.
  static const Set<String> reauthRequired = <String>{
    requiresOtp,
    refreshReuseDetected,
    deviceRevoked,
  };
}

/// A typed auth error parsed from the API error body
/// (`{ code, message, retry_after_seconds, attempts_left }`).
///
/// Standalone (NOT part of the sealed [Failure] hierarchy, which can't be
/// extended cross-library): it carries the auth-specific `code` plus the
/// rate-limit / lockout metadata the UI needs (countdown, remaining attempts).
/// It is thrown by [AuthApi] methods and caught by PASS 2's cubits.
///
/// PASS 2's UI maps [code] → localized copy via `auth_error_messages.dart`; it
/// never shows [message] (which may carry server detail) directly.
class AuthFailure extends Equatable implements Exception {
  const AuthFailure(
    this.code, {
    this.retryAfter,
    this.attemptsLeft,
    this.message = 'Please try again.',
  });

  /// One of [AuthErrorCode]. Drives all logic + the localized message lookup.
  final String code;

  /// A generic, PII-free fallback string. Display copy comes from
  /// `auth_error_messages.dart` keyed by [code]; this is only a last resort.
  final String message;

  /// Seconds to wait before retrying (from `retry_after_seconds`). Null when the
  /// server did not send one (e.g. a plain invalid-PIN).
  final Duration? retryAfter;

  /// Remaining attempts before a lock (from `attempts_left`). Null when absent.
  final int? attemptsLeft;

  bool get isReauthRequired => AuthErrorCode.reauthRequired.contains(code);
  bool get isNetwork => code == AuthErrorCode.network;

  @override
  List<Object?> get props => <Object?>[code, message, retryAfter, attemptsLeft];

  @override
  String toString() =>
      'AuthFailure($code, retryAfter: $retryAfter, attemptsLeft: $attemptsLeft)';
}

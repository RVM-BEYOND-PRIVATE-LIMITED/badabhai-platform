import 'package:equatable/equatable.dart';

/// The CLIENT-derived set of auth error codes.
///
/// The REAL backend (ADR-0026) returns plain NestJS errors — `{ statusCode,
/// message }` with NO `code` field, and PIN/refresh failures collapse to one
/// opaque 401. So these codes are NOT parsed off the wire: they are derived by
/// [AuthApi]'s endpoint-aware mapper from `(endpoint kind, HTTP status)`. Logic
/// keys off these constants; the human-readable copy comes from
/// `auth_error_messages.dart` (with the server `message` preferred where the
/// contract surfaces a meaningful one — rate-limit / unavailable / weak-PIN).
abstract final class AuthErrorCode {
  /// Wrong / expired OTP code (otp/verify 401, pin/reset/confirm 401).
  static const String otpInvalid = 'OTP_INVALID';

  /// OTP requested / attempted too often (429 on the OTP + reset endpoints).
  static const String otpRateLimited = 'OTP_RATE_LIMITED';

  /// PIN unlock failed — NEUTRAL: the backend returns one opaque 401 on every
  /// PIN failure (no oracle, no attempts-left, no retry-after).
  static const String pinVerifyFailed = 'PIN_VERIFY_FAILED';

  /// PIN rejected as weak / malformed (pin/set 400, pin/reset/confirm 400).
  static const String pinWeak = 'PIN_WEAK';

  /// The session must re-authenticate from scratch (refresh 401 — invalid /
  /// reuse / requires_otp, all neutral). Clears the store and bounces to OTP.
  static const String reauthRequired = 'REAUTH_REQUIRED';

  /// Provider / server unavailable (503).
  static const String unavailable = 'UNAVAILABLE';

  /// Transport / offline failure — emitted by the interceptor when a request
  /// can't reach the host (never sent by the server).
  static const String network = 'NETWORK';

  /// Catch-all when the (endpoint, status) pair has no specific mapping.
  static const String unknown = 'UNKNOWN';
}

/// A typed auth error built by [AuthApi]'s `(endpoint, status)` mapper.
///
/// Standalone (NOT part of the sealed [Failure] hierarchy, which can't be
/// extended cross-library). It carries a CLIENT-derived [code] plus the optional
/// HTTP [statusCode] and a generic [message]. There is NO attempts-left /
/// retry-after metadata — the real backend does not send any (PIN failures are a
/// single opaque 401), so the UI shows neutral copy with a client-side
/// "forgot PIN?" nudge instead of a countdown.
///
/// PASS 2's UI maps [code] → localized copy via `auth_error_messages.dart`
/// (preferring the server [message] for the few codes where it is meaningful).
class AuthFailure extends Equatable implements Exception {
  const AuthFailure(
    this.code, {
    this.statusCode,
    this.message = 'Please try again.',
  });

  /// One of [AuthErrorCode]. Drives all logic + the localized message lookup.
  final String code;

  /// The HTTP status the failure was derived from (null for synthetic/network).
  final int? statusCode;

  /// The server's PII-free `message` (or a generic fallback). Display copy comes
  /// from `auth_error_messages.dart`; this is preferred only for the codes that
  /// carry a meaningful server message (rate-limit / unavailable / weak-PIN).
  final String message;

  bool get isReauthRequired => code == AuthErrorCode.reauthRequired;
  bool get isNetwork => code == AuthErrorCode.network;

  @override
  List<Object?> get props => <Object?>[code, statusCode, message];

  @override
  String toString() => 'AuthFailure($code, statusCode: $statusCode)';
}

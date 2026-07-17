import 'package:flutter/foundation.dart' show kReleaseMode;

import '../api/api_client.dart';
import '../api/mock_api_client.dart';

/// Single switch: MOCK (no backend, canned data) vs REAL (live NestJS API).
///
/// Flip via:  `flutter run --dart-define=USE_MOCKS=true`
///
/// Defaults to `false` so REAL mode is the default and CI never ships mocks.
/// When `false` the app behaves byte-for-byte as it does today against the live
/// [ApiClient]; when `true` every external call is served by [MockApiClient] from
/// canned, PII-free data, so the whole UI (splash → login → OTP → consent → chat
/// → profile → resume → swipe) is walkable with no backend running.
const bool kUseMocks = bool.fromEnvironment('USE_MOCKS', defaultValue: false);

/// Persistent-auth / PIN layer (PASS 2) enable gate.
///
/// ON by default now that the ADR-0026 backend contract is LIVE + reconciled
/// (Phase 4): `/auth/otp/verify` (with `pin_set` + `is_new_worker`),
/// `/auth/pin/{set,verify,reset/request,reset/confirm}`, `/auth/token/refresh`,
/// and `/auth/devices` are all wired, and `auth_api.dart` matches the real wire
/// shapes (no more `// ASSUMED`). With the layer ON, a persisted refresh token
/// lets a returning worker resume (locked → enter-PIN) instead of re-doing OTP,
/// so restarts survive. It NEVER auto-unlocks: bootstrap resolves to `locked`
/// when a token is present, else `loggedOut`; the first cold start is still
/// `loggedOut` until one OTP login persists a token.
///
/// Always ON in mock mode; switch OFF for a build via
/// `--dart-define=PERSISTENT_AUTH=false` if ever needed.
const bool kPersistentAuth =
    kUseMocks || bool.fromEnvironment('PERSISTENT_AUTH', defaultValue: true);

/// Absolute base for referral invite links (A3). The `POST /invites` response
/// carries a SERVER-RELATIVE `link` (`/i/<code>`); the share sheet prepends this
/// so the shared text is a tappable URL. Overridable per build:
///   flutter run --dart-define=INVITE_LINK_BASE=https://app.badabhai.in
/// Trailing slash is trimmed by the caller. PII-free — the code is opaque.
const String kInviteLinkBase = String.fromEnvironment(
  'INVITE_LINK_BASE',
  defaultValue: 'https://app.badabhai.in',
);

/// The build-time API base URL. A RELEASE build MUST supply it:
///   flutter build apk --dart-define=API_BASE_URL=https://api.example.com
/// Empty in debug falls back to [_kDebugFallbackBaseUrl].
const String _kApiBaseUrl = String.fromEnvironment('API_BASE_URL');

/// Debug-ONLY fallback: the API on the host loopback. Never reachable from a
/// real device, so it must never leak into a release build —
/// [resolveApiBaseUrl] enforces that.
const String _kDebugFallbackBaseUrl = 'http://localhost:3001';

/// Resolves the API base URL, failing LOUDLY in release rather than silently
/// pointing a shipped app at localhost.
///
///  - RELEASE: `API_BASE_URL` is REQUIRED and must be a well-formed `https://`
///    origin. A missing/plaintext/malformed value throws [StateError] at
///    startup — a hard, obvious boot failure beats an app on a worker's phone
///    quietly failing every request against `localhost`.
///  - DEBUG / TEST: `API_BASE_URL` wins when supplied; otherwise the loopback
///    keeps the local loop working with no extra flags.
///
/// [configuredUrl] and [isRelease] are injectable ONLY so the release rules can
/// be unit-tested (a test always runs in debug, and `API_BASE_URL` is fixed at
/// compile time). Production callers pass neither.
///
/// Throws [StateError] in a release build with no/invalid `API_BASE_URL`.
String resolveApiBaseUrl({String? configuredUrl, bool? isRelease}) {
  final String configured = (configuredUrl ?? _kApiBaseUrl).trim();
  final bool release = isRelease ?? kReleaseMode;

  if (!release) {
    return configured.isEmpty ? _kDebugFallbackBaseUrl : configured;
  }

  if (configured.isEmpty) {
    throw StateError(
      'API_BASE_URL is not set. A release build must be built with '
      '--dart-define=API_BASE_URL=https://<your-api-host> — refusing to fall '
      'back to the debug loopback ($_kDebugFallbackBaseUrl).',
    );
  }
  final Uri? uri = Uri.tryParse(configured);
  if (uri == null || !uri.isAbsolute || uri.host.isEmpty) {
    throw StateError(
      'API_BASE_URL ("$configured") is not an absolute URL with a host.',
    );
  }
  // Plaintext transport would put the session token on the wire in the clear.
  if (uri.scheme != 'https') {
    throw StateError(
      'API_BASE_URL ("$configured") must use https in a release build; '
      'got scheme "${uri.scheme}".',
    );
  }
  return configured;
}

/// The single place that picks the API client.
///
/// Screens construct their client through this factory so the [kUseMocks] switch
/// selects MOCK vs REAL in exactly one spot. [onSessionTokenRefreshed] is
/// forwarded to the real client (the swipe screen relies on it to keep the
/// rolling session token fresh); the mock has no network, so it never invokes
/// the callback.
ApiClient createApiClient({
  void Function(String)? onSessionTokenRefreshed,
  Future<bool> Function()? onUnauthorized,
  String? Function()? currentAuthToken,
}) =>
    kUseMocks
        ? MockApiClient()
        : ApiClient(
            onSessionTokenRefreshed: onSessionTokenRefreshed,
            // #351: lets a 401 on the legacy worker-scoped path renew auth once
            // instead of dead-ending the worker behind the router redirect.
            onUnauthorized: onUnauthorized,
            currentAuthToken: currentAuthToken,
          );

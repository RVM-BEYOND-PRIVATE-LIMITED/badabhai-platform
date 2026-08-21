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

/// TEST-ONLY affordance: shows a "Delete account (test)" button in the Profile
/// tab that immediately deletes the signed-in worker's own account (no DBA, no
/// 7-day grace) so QA can exercise the account-deletion flow end to end.
///
/// Compiled OUT of a normal release — the button never renders unless the build
/// opts in:  `flutter build apk --dart-define=ENABLE_TEST_DELETE=true`. Because
/// this is a compile-time `const false` by default, the entire button subtree is
/// tree-shaken from a stock release; a shipped store build can never carry it.
const bool kEnableTestDelete =
    bool.fromEnvironment('ENABLE_TEST_DELETE', defaultValue: false);

/// Absolute base for referral invite links (A3). The `POST /invites` response
/// carries a SERVER-RELATIVE `link` (`/i/<code>`); the share sheet prepends this
/// so the shared text is a tappable URL. Overridable per build:
///   flutter run --dart-define=INVITE_LINK_BASE=https://payer.43-204-36-199.sslip.io
/// Trailing slash is trimmed by the caller. PII-free — the code is opaque.
///
/// #1144: points at the ruled INTERIM invite origin (#1138) — the host that
/// actually serves `/.well-known/assetlinks.json` + `/i/<code>` (#1139). MUST
/// match the App Link `android:host` in AndroidManifest.xml. The Lightsail IP is
/// inside the hostname, so this WILL move — keep it one easy-to-change constant.
const String kInviteLinkBase = String.fromEnvironment(
  'INVITE_LINK_BASE',
  defaultValue: 'https://payer.43-204-36-199.sslip.io',
);

/// The build-time API base URL OVERRIDE. Supply it to point a build at a
/// specific backend — notably the real PRODUCTION host for a Play Store release:
///   flutter build apk --dart-define=API_BASE_URL=https://api.example.com
/// When empty, the app uses [_kDefaultBaseUrl].
const String _kApiBaseUrl = String.fromEnvironment('API_BASE_URL');

/// The backend the app uses when NO `API_BASE_URL` override is supplied, so a
/// plain `flutter run` / `flutter build apk` reaches a LIVE API with no flags and
/// no local server running. Currently the shared test/staging backend (TLS via
/// sslip.io → the Lightsail host).
///
/// It is an `https://` origin, so it is safe in a release build (the session
/// token never rides in the clear). PRODUCTION: the Play Store build should still
/// OVERRIDE this with the real production host
/// (`--dart-define=API_BASE_URL=https://<prod-host>`) so the store app does not
/// point at the staging box.
const String _kDefaultBaseUrl = 'https://43-204-36-199.sslip.io';

/// Resolves the API base URL.
///
///  - An explicit `API_BASE_URL` always WINS. In a RELEASE build it must be a
///    well-formed `https://` origin — a plaintext or malformed override throws
///    [StateError] at startup (a hard boot failure beats a shipped app that
///    silently fails every request, or puts the session token on the wire in the
///    clear).
///  - With NO override, the app falls back to [_kDefaultBaseUrl] — a live
///    `https` origin, never localhost — in both debug and release, so a plain
///    build works out of the box.
///
/// [configuredUrl] and [isRelease] are injectable ONLY so the release rules can
/// be unit-tested (a test always runs in debug, and `API_BASE_URL` is fixed at
/// compile time). Production callers pass neither.
String resolveApiBaseUrl({String? configuredUrl, bool? isRelease}) {
  final String configured = (configuredUrl ?? _kApiBaseUrl).trim();
  final bool release = isRelease ?? kReleaseMode;

  // No override → the shared default backend (https, never localhost), so a
  // plain build reaches a live API in both debug and release.
  if (configured.isEmpty) return _kDefaultBaseUrl;

  // An explicit override in a release build must be a well-formed https origin.
  if (release) {
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
  void Function()? onAccountDeleted,
  String? Function()? currentAuthToken,
}) =>
    kUseMocks
        ? MockApiClient()
        : ApiClient(
            onSessionTokenRefreshed: onSessionTokenRefreshed,
            // #351: lets a 401 on the legacy worker-scoped path renew auth once
            // instead of dead-ending the worker behind the router redirect.
            onUnauthorized: onUnauthorized,
            // A 410 { code: WORKER_ACCOUNT_DELETED } → hard-logout dialog. The
            // mock has no network, so it never invokes the callback.
            onAccountDeleted: onAccountDeleted,
            currentAuthToken: currentAuthToken,
          );

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

/// The single place that picks the API client.
///
/// Screens construct their client through this factory so the [kUseMocks] switch
/// selects MOCK vs REAL in exactly one spot. [onSessionTokenRefreshed] is
/// forwarded to the real client (the swipe screen relies on it to keep the
/// rolling session token fresh); the mock has no network, so it never invokes
/// the callback.
ApiClient createApiClient({void Function(String)? onSessionTokenRefreshed}) =>
    kUseMocks
        ? MockApiClient()
        : ApiClient(onSessionTokenRefreshed: onSessionTokenRefreshed);

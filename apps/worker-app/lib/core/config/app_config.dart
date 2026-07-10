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
/// OFF by default in REAL builds: the backend `/auth/pin/*`, `/auth/token/refresh`,
/// `/auth/devices` contract is not live yet and the `/auth/otp/verify` response
/// shape differs from this client's ASSUMED shape, so running the PIN gate against
/// the real backend dead-ends the worker after OTP. With the layer OFF, OTP login
/// falls back to the proven OTP→shell flow (exactly as on main).
///
/// ON automatically in mock mode (the full PIN flow is walkable), and switchable
/// for staging via `--dart-define=PERSISTENT_AUTH=true` once the backend contract
/// lands and `auth_api.dart`'s `// ASSUMED` shapes are reconciled.
const bool kPersistentAuth =
    kUseMocks || bool.fromEnvironment('PERSISTENT_AUTH', defaultValue: false);

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

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

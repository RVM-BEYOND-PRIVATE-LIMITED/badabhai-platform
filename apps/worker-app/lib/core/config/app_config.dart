import '../api/api_client.dart';

/// The single place that picks the API client.
///
/// The app talks to the live NestJS API ONLY — there is no mock/dev/canned
/// path. The base URL is resolved by [ApiClient] from `--dart-define=API_BASE_URL`
/// (defaulting to `http://localhost:3001`). Screens construct their client
/// through this factory so the wiring lives in exactly one spot.
///
/// [onSessionTokenRefreshed] is forwarded to the client (the swipe screen relies
/// on it to keep the rolling session token fresh).
ApiClient createApiClient({void Function(String)? onSessionTokenRefreshed}) =>
    ApiClient(onSessionTokenRefreshed: onSessionTokenRefreshed);

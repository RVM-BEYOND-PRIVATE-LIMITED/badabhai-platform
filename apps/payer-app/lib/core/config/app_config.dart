import '../auth/payer_auth_api.dart';
import '../auth/payer_http.dart';
import '../auth/payer_token_store.dart';
import '../data/http_payer_api_client.dart';
import '../data/mock_payer_api_client.dart';
import '../data/payer_account_api.dart';
import '../data/payer_api_client.dart';

/// Single switch: MOCK (canned, PII-free data) vs REAL (live API).
///
/// MOCK is the DEFAULT so the whole UI is walkable with no backend — same as the
/// worker app's mock-mode seam. Flip to the real API with:
///   flutter run --dart-define=USE_MOCKS=false \
///               --dart-define=PAYER_API_BASE_URL=http://10.0.2.2:3001
/// (10.0.2.2 is the Android emulator's alias for the host machine.)
const bool kUseMocks = bool.fromEnvironment('USE_MOCKS', defaultValue: true);

/// Base URL of the NestJS payer API. Defaults to the Android emulator host alias
/// on the API's port (3001).
const String kPayerApiBaseUrl = String.fromEnvironment(
  'PAYER_API_BASE_URL',
  defaultValue: 'http://10.0.2.2:3001',
);

/// The single place that picks the data client. Screens resolve their client
/// through the locator, which calls this factory, so MOCK vs REAL is chosen in
/// exactly one spot.
///
/// In REAL mode the [PayerHttp] is supplied (wired in the locator with the token
/// store); in MOCK mode it is ignored.
PayerApiClient createPayerApiClient({PayerHttp? http}) {
  if (kUseMocks || http == null) {
    return MockPayerApiClient();
  }
  return HttpPayerApiClient(http);
}

/// Picks the auth API: the mock (any email/code signs in) vs the real `/payer/*`
/// auth over [PayerHttp].
PayerAuthApi createPayerAuthApi({PayerHttp? http}) {
  if (kUseMocks || http == null) {
    return MockPayerAuthApi();
  }
  return HttpPayerAuthApi(http);
}

/// Picks the Account (`/payer/me`) API: the MOCK (canned, role-aware, PII-free)
/// vs the real `/payer/me` over [PayerHttp]. Mirrors [createPayerApiClient] so
/// MOCK vs REAL is chosen in exactly one place. In MOCK mode the [tokens] role
/// drives the canned identity; in REAL mode [http] carries the bearer.
PayerAccountApi createPayerAccountApi({
  PayerHttp? http,
  required PayerTokenStore tokens,
}) {
  if (kUseMocks || http == null) {
    return MockPayerAccountApi(tokens);
  }
  return HttpPayerAccountApi(http);
}

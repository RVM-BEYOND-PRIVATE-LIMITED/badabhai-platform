import 'package:flutter/foundation.dart' show kReleaseMode;

import '../auth/payer_auth_api.dart';
import '../auth/payer_http.dart';
import '../auth/payer_token_store.dart';
import '../data/http_payer_api_client.dart';
import '../data/mock_payer_api_client.dart';
import '../data/payer_account_api.dart';
import '../data/payer_api_client.dart';

/// Single switch: REAL (live API) vs MOCK (canned, PII-free data).
///
/// REAL is the DEFAULT (matches the worker app) so the app runs against the live
/// payer API out of the box. Walk the UI with no backend via:
///   flutter run --dart-define=USE_MOCKS=true
///
/// In REAL mode NOTHING is canned: every surface the app renders is backed by a
/// live `/payer/*` route. Surfaces without one were REMOVED rather than faked.
const bool kUseMocks = bool.fromEnvironment('USE_MOCKS', defaultValue: false);

/// The build-time API base URL. A RELEASE build MUST supply it:
///   flutter build apk --dart-define=API_BASE_URL=https://api.example.com
/// Empty in debug falls back to [_kDebugFallbackBaseUrl].
const String _kApiBaseUrl = String.fromEnvironment('API_BASE_URL');

/// Debug-ONLY fallback: the Android emulator host alias on the API's port. This
/// is never reachable from a real device, so it must never leak into a release
/// build — [resolvePayerApiBaseUrl] enforces that.
const String _kDebugFallbackBaseUrl = 'http://10.0.2.2:3001';

/// Resolves the payer API base URL, failing LOUDLY in release rather than
/// silently pointing a shipped app at an emulator alias.
///
///  - RELEASE: `API_BASE_URL` is REQUIRED and must be a well-formed `https://`
///    origin. A missing/plaintext/malformed value throws [StateError] at
///    startup (see `setupLocator`) — a hard, obvious boot failure beats an app
///    on a user's phone quietly failing every request against `10.0.2.2`.
///  - DEBUG / TEST: `API_BASE_URL` wins when supplied; otherwise the emulator
///    alias keeps the local loop working with no extra flags.
///
/// [configuredUrl] and [isRelease] are injectable ONLY so the release rules can
/// be unit-tested (a test always runs in debug, and `API_BASE_URL` is fixed at
/// compile time). Production callers pass neither.
///
/// Throws [StateError] in a release build with no/invalid `API_BASE_URL`.
String resolvePayerApiBaseUrl({String? configuredUrl, bool? isRelease}) {
  final String configured = (configuredUrl ?? _kApiBaseUrl).trim();
  final bool release = isRelease ?? kReleaseMode;

  if (!release) {
    return configured.isEmpty ? _kDebugFallbackBaseUrl : configured;
  }

  if (configured.isEmpty) {
    throw StateError(
      'API_BASE_URL is not set. A release build must be built with '
      '--dart-define=API_BASE_URL=https://<your-api-host> — refusing to fall '
      'back to the debug emulator alias ($_kDebugFallbackBaseUrl).',
    );
  }
  final Uri? uri = Uri.tryParse(configured);
  if (uri == null || !uri.isAbsolute || uri.host.isEmpty) {
    throw StateError(
      'API_BASE_URL ("$configured") is not an absolute URL with a host.',
    );
  }
  // Plaintext transport would put the bearer token on the wire in the clear.
  if (uri.scheme != 'https') {
    throw StateError(
      'API_BASE_URL ("$configured") must use https in a release build; '
      'got scheme "${uri.scheme}".',
    );
  }
  return configured;
}

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

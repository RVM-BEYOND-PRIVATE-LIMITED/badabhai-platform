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

/// The build-time API base URL OVERRIDE. Supply it to point a build at a
/// specific backend — notably the real PRODUCTION host for a store release:
///   flutter build apk --dart-define=API_BASE_URL=https://api.example.com
/// When empty, the app uses [_kDefaultBaseUrl].
const String _kApiBaseUrl = String.fromEnvironment('API_BASE_URL');

/// The backend the payer app uses when NO `API_BASE_URL` override is supplied,
/// so a plain `flutter run` / `flutter build apk` reaches a LIVE API with no
/// flags and no local server or `adb reverse`. Currently the shared test/staging
/// backend (TLS via sslip.io → the Lightsail host) — the SAME origin the worker
/// app defaults to.
///
/// It is an `https://` origin, so it is safe in a release build (the bearer
/// token never rides in the clear). PRODUCTION: a store build should still
/// OVERRIDE this with the real production host
/// (`--dart-define=API_BASE_URL=https://<prod-host>`) so it does not point at the
/// staging box.
const String _kDefaultBaseUrl = 'https://43-204-36-199.sslip.io';

/// Resolves the payer API base URL.
///
///  - An explicit `API_BASE_URL` always WINS. In a RELEASE build it must be a
///    well-formed `https://` origin — a plaintext or malformed override throws
///    [StateError] at startup (see `setupLocator`): a hard boot failure beats a
///    shipped app that silently fails every request or puts the bearer token on
///    the wire in the clear.
///  - With NO override, the app falls back to [_kDefaultBaseUrl] — a live
///    `https` origin, never localhost — in both debug and release, so a plain
///    build works out of the box.
///
/// [configuredUrl] and [isRelease] are injectable ONLY so the release rules can
/// be unit-tested (a test always runs in debug, and `API_BASE_URL` is fixed at
/// compile time). Production callers pass neither.
String resolvePayerApiBaseUrl({String? configuredUrl, bool? isRelease}) {
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
    // Plaintext transport would put the bearer token on the wire in the clear.
    if (uri.scheme != 'https') {
      throw StateError(
        'API_BASE_URL ("$configured") must use https in a release build; '
        'got scheme "${uri.scheme}".',
      );
    }
  }
  return configured;
}

/// The payer/agency WEB portal origin (`apps/payer-web`), overridable at build
/// time with `--dart-define=PAYER_WEB_URL=https://…`.
///
/// WHY THE APP NEEDS ONE AT ALL: every money action — buying a plan, a boost, a
/// quota top-up, credits — is deliberately absent from this app so it can never
/// trip App Store / Play Store in-app-purchase policy. That leaves the payer
/// needing somewhere to go, and a dead end ("not available here", full stop) is
/// how a real capability gets read as a broken app. So the app POINTS, and the
/// purchase itself happens on the web, outside the store's payment rules.
const String _kPayerWebUrl = String.fromEnvironment('PAYER_WEB_URL');

/// Default payer-web origin, matching the origin the server config already
/// documents for this app (`packages/config/src/server.ts` — the
/// `MEMBER_INVITE_ACCEPT_URL` / CORS examples). Overridable per build.
const String _kDefaultPayerWebUrl = 'https://app.badabhai.in';

/// Resolves the payer-web origin an external "manage this on the web" link
/// opens. Returns null when the configured value is not a usable absolute URL,
/// so the caller renders the honest text WITHOUT a broken link rather than
/// launching something that cannot resolve.
///
/// [configuredUrl] is injectable only so the rules can be unit-tested (the
/// dart-define is fixed at compile time). Production callers pass nothing.
String? resolvePayerWebUrl({String? configuredUrl}) {
  final String configured = (configuredUrl ?? _kPayerWebUrl).trim();
  final String candidate =
      configured.isEmpty ? _kDefaultPayerWebUrl : configured;
  final Uri? uri = Uri.tryParse(candidate);
  if (uri == null || !uri.isAbsolute || uri.host.isEmpty) return null;
  // Plaintext would send a signed-in payer to an unprotected origin.
  if (uri.scheme != 'https') return null;
  return candidate;
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

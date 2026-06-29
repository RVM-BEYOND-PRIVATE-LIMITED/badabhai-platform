import '../config/app_config.dart';
import 'auth_api.dart';
import 'authed_client.dart';
import 'device_id.dart';
import 'locale_store.dart';
import 'mock_auth_api.dart';
import 'reauth_signal.dart';
import 'secure_token_store.dart';

/// The single place that picks the [AuthApi] implementation — REAL (live /auth/*
/// over [AuthedClient]) vs MOCK ([MockAuthApi], canned PII-free data), driven by
/// the [kUseMocks] dart-define. Mirrors `createApiClient` so the MOCK vs REAL
/// switch lives in exactly one spot per subsystem.
///
/// In REAL mode the full signing chain is built: the [AuthedClient] injects
/// `X-Device-Id` / `X-Locale`, signs with the bearer from [tokenStore], and runs
/// single-flight proactive/reactive refresh, firing [reauthSignal] on an
/// unrecoverable failure. In MOCK mode the client chain is bypassed entirely —
/// every method is served from [tokenStore]-backed canned data.
AuthApi createAuthApi({
  required SecureTokenStore tokenStore,
  required DeviceIdProvider deviceId,
  required LocaleStore localeStore,
  required ReauthSignal reauthSignal,
  String? baseUrl,
}) {
  if (kUseMocks) {
    return MockAuthApi(tokenStore);
  }
  final AuthedClient client = AuthedClient(
    baseUrl: baseUrl ??
        const String.fromEnvironment(
          'API_BASE_URL',
          defaultValue: 'http://localhost:3001',
        ),
    tokenStore: tokenStore,
    deviceId: deviceId,
    localeStore: localeStore,
    reauthSignal: reauthSignal,
  );
  return AuthApi(client);
}

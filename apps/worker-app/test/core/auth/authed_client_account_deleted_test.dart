import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart' show kRequestTimeout;
import 'package:badabhai_worker_app/core/auth/authed_client.dart';
import 'package:badabhai_worker_app/core/auth/device_id.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/reauth_signal.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';

import 'fakes.dart';

/// The account-deleted contract can arrive on the AUTH / refresh path too (not
/// just data reads), so [AuthedClient] fires [onAccountDeleted] on the same
/// predicate — 410 Gone AND `code == 'WORKER_ACCOUNT_DELETED'` — while still
/// returning the [AuthResponse] unchanged so the caller keeps failing as before.
AuthedClient _client(
  MockClient transport, {
  required SecureTokenStore tokenStore,
  void Function()? onAccountDeleted,
}) {
  return AuthedClient(
    baseUrl: 'http://test',
    tokenStore: tokenStore,
    deviceId: DeviceIdProvider(tokenStore),
    localeStore: LocaleStore(FakePrefs()),
    reauthSignal: ReauthSignal(),
    onAccountDeleted: onAccountDeleted,
    client: transport,
    retryBackoff: Duration.zero,
    requestTimeout: kRequestTimeout,
  );
}

void main() {
  group('AuthedClient WORKER_ACCOUNT_DELETED (410) detection', () {
    test('REAL envelope: 410 + { error: { code } } fires, response still 410',
        () async {
      int fired = 0;
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      final AuthedClient client = _client(
        MockClient((http.Request req) async => http.Response(
              // The real wire shape: AllExceptionsFilter nests under `error`.
              jsonEncode(<String, dynamic>{
                'statusCode': 410,
                'error': <String, dynamic>{
                  'code': 'WORKER_ACCOUNT_DELETED',
                  'message': 'This account no longer exists.',
                },
              }),
              410,
            )),
        tokenStore: store,
        onAccountDeleted: () => fired++,
      );

      final AuthResponse res = await client.send(HttpMethod.get, '/me');

      expect(res.statusCode, 410, reason: 'the caller still sees the 410');
      expect(fired, 1, reason: 'exactly one hard-logout signal on the real shape');
    });

    test('a bare 410 (no code) does NOT fire', () async {
      int fired = 0;
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      final AuthedClient client = _client(
        MockClient((http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{}), 410)),
        tokenStore: store,
        onAccountDeleted: () => fired++,
      );

      final AuthResponse res = await client.send(HttpMethod.get, '/me');

      expect(res.statusCode, 410);
      expect(fired, 0, reason: 'a bare 410 must never force a logout');
    });

    test('a 410 with a different code does NOT fire', () async {
      int fired = 0;
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      final AuthedClient client = _client(
        MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{'code': 'RESOURCE_GONE'}), 410)),
        tokenStore: store,
        onAccountDeleted: () => fired++,
      );

      await client.send(HttpMethod.get, '/me');

      expect(fired, 0);
    });
  });
}

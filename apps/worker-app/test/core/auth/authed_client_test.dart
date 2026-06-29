import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/auth/authed_client.dart';
import 'package:badabhai_worker_app/core/auth/device_id.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/reauth_signal.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';

import 'fakes.dart';

/// Builds an [AuthedClient] over the supplied [MockClient] transport with all
/// auth dependencies backed by in-memory fakes. [expiresAt] seeds the access
/// token expiry (null = no token yet).
AuthedClient _client(
  MockClient transport, {
  required SecureTokenStore tokenStore,
  required ReauthSignal signal,
}) {
  return AuthedClient(
    baseUrl: 'http://test',
    tokenStore: tokenStore,
    deviceId: DeviceIdProvider(tokenStore),
    localeStore: LocaleStore(FakePrefs()),
    reauthSignal: signal,
    client: transport,
    retryBackoff: Duration.zero,
  );
}

void main() {
  group('AuthedClient interceptor', () {
    test('injects X-Device-Id + X-Locale on every request', () async {
      late http.Request captured;
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      final AuthedClient client = _client(
        MockClient((http.Request req) async {
          captured = req;
          return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
        }),
        tokenStore: store,
        signal: ReauthSignal(),
      );

      await client.send(HttpMethod.get, '/anything');

      expect(captured.headers['X-Device-Id'], isNotEmpty);
      expect(captured.headers['X-Locale'], 'hi'); // default locale
    });

    test('adds + reuses one Idempotency-Key across a network retry', () async {
      final List<String?> seenKeys = <String?>[];
      int calls = 0;
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      final AuthedClient client = _client(
        MockClient((http.Request req) async {
          seenKeys.add(req.headers['Idempotency-Key']);
          calls++;
          // Fail the first attempt with a transport error, succeed the second.
          if (calls == 1) throw const SocketException('flaky');
          return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
        }),
        tokenStore: store,
        signal: ReauthSignal(),
      );

      final AuthResponse res = await client.send(
        HttpMethod.post,
        '/auth/otp/request',
        body: <String, dynamic>{'phone': '+910000000000'},
        idempotent: true,
      );

      expect(res.isSuccess, isTrue);
      expect(calls, 2, reason: 'one retry after the flaky failure');
      expect(seenKeys, hasLength(2));
      expect(seenKeys[0], isNotNull);
      expect(seenKeys[0], seenKeys[1],
          reason: 'the SAME Idempotency-Key is reused on the retry');
    });

    test('exhausted network retries surface a NETWORK AuthFailure', () async {
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      final AuthedClient client = _client(
        MockClient((http.Request req) async {
          throw const SocketException('down');
        }),
        tokenStore: store,
        signal: ReauthSignal(),
      );

      expect(
        () => client.send(
          HttpMethod.post,
          '/auth/otp/request',
          body: <String, dynamic>{},
          idempotent: true,
        ),
        throwsA(isA<AuthFailure>()
            .having((AuthFailure f) => f.code, 'code', AuthErrorCode.network)),
      );
    });

    test(
        'expired access → exactly ONE refresh under N concurrent calls, then '
        'each original retried with the new token', () async {
      int refreshCalls = 0;
      final List<String?> protectedAuthHeaders = <String?>[];

      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      // Seed an EXPIRED access token + a valid refresh token.
      await store.saveTokens(
        refreshToken: 'refresh-old',
        accessExpiresAt: DateTime.now().subtract(const Duration(minutes: 1)),
        accessToken: 'access-expired',
      );

      final AuthedClient client = _client(
        MockClient((http.Request req) async {
          if (req.url.path == '/auth/token/refresh') {
            refreshCalls++;
            return http.Response(
              jsonEncode(<String, dynamic>{
                'access_token': 'access-new',
                'refresh_token': 'refresh-new',
                'access_expires_in': 900,
              }),
              200,
            );
          }
          protectedAuthHeaders.add(req.headers['authorization']);
          return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
        }),
        tokenStore: store,
        signal: ReauthSignal(),
      );

      // Fire N concurrent protected calls — all see the expired token at once.
      await Future.wait<AuthResponse>(<Future<AuthResponse>>[
        client.send(HttpMethod.get, '/protected/1', authed: true),
        client.send(HttpMethod.get, '/protected/2', authed: true),
        client.send(HttpMethod.get, '/protected/3', authed: true),
      ]);

      expect(refreshCalls, 1,
          reason: 'single-flight: N concurrent calls trigger ONE refresh');
      // The rotated refresh token is now persisted.
      expect(await store.readRefreshToken(), 'refresh-new');
      expect(store.accessToken, 'access-new');
      // Every protected call carried the NEW bearer.
      expect(protectedAuthHeaders, hasLength(3));
      expect(
        protectedAuthHeaders.every((String? h) => h == 'Bearer access-new'),
        isTrue,
      );
    });

    test('reactive 401 → refresh → original retried once with the new token',
        () async {
      int refreshCalls = 0;
      int protectedCalls = 0;
      final List<String?> authHeaders = <String?>[];
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      // Valid (not-expired) access token so proactive refresh does NOT fire.
      await store.saveTokens(
        refreshToken: 'refresh-old',
        accessExpiresAt: DateTime.now().add(const Duration(minutes: 10)),
        accessToken: 'access-stale',
      );

      final AuthedClient client = _client(
        MockClient((http.Request req) async {
          if (req.url.path == '/auth/token/refresh') {
            refreshCalls++;
            return http.Response(
              jsonEncode(<String, dynamic>{
                'access_token': 'access-fresh',
                'refresh_token': 'refresh-fresh',
                'access_expires_in': 900,
              }),
              200,
            );
          }
          protectedCalls++;
          authHeaders.add(req.headers['authorization']);
          // First protected attempt 401s; the retry (new token) succeeds.
          if (protectedCalls == 1) {
            return http.Response(jsonEncode(<String, dynamic>{}), 401);
          }
          return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
        }),
        tokenStore: store,
        signal: ReauthSignal(),
      );

      final AuthResponse res =
          await client.send(HttpMethod.get, '/protected', authed: true);

      expect(res.isSuccess, isTrue);
      expect(refreshCalls, 1);
      expect(protectedCalls, 2, reason: 'original retried exactly once');
      expect(authHeaders.first, 'Bearer access-stale');
      expect(authHeaders.last, 'Bearer access-fresh');
    });

    test('REFRESH_REUSE_DETECTED → store cleared + requiresReauth fired',
        () async {
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      await store.saveTokens(
        refreshToken: 'refresh-reused',
        accessExpiresAt: DateTime.now().subtract(const Duration(minutes: 1)),
        accessToken: 'access-old',
      );
      await store.writeWorkerId('worker-x');

      final ReauthSignal signal = ReauthSignal();
      bool fired = false;
      signal.stream.listen((_) => fired = true);

      final AuthedClient client = _client(
        MockClient((http.Request req) async {
          if (req.url.path == '/auth/token/refresh') {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'code': AuthErrorCode.refreshReuseDetected,
                'message': 'reuse',
              }),
              401,
            );
          }
          return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
        }),
        tokenStore: store,
        signal: signal,
      );

      await client.send(HttpMethod.get, '/protected', authed: true);
      // Let the broadcast microtask deliver.
      await Future<void>.delayed(Duration.zero);

      expect(fired, isTrue, reason: 'reauth signal must fire');
      expect(await store.readRefreshToken(), isNull, reason: 'store cleared');
      expect(await store.readWorkerId(), isNull);
      expect(store.accessToken, isNull);
    });

    test('missing refresh token → clears + fires reauth (no network refresh)',
        () async {
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      // Expired access, NO refresh token persisted.
      store.accessToken = 'access-orphan';
      await store.writeAccessExpiresAt(
        DateTime.now().subtract(const Duration(minutes: 1)),
      );

      final ReauthSignal signal = ReauthSignal();
      bool fired = false;
      signal.stream.listen((_) => fired = true);

      int refreshCalls = 0;
      final AuthedClient client = _client(
        MockClient((http.Request req) async {
          if (req.url.path == '/auth/token/refresh') refreshCalls++;
          return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
        }),
        tokenStore: store,
        signal: signal,
      );

      await client.send(HttpMethod.get, '/protected', authed: true);
      await Future<void>.delayed(Duration.zero);

      expect(refreshCalls, 0, reason: 'no refresh token → no network call');
      expect(fired, isTrue);
      expect(store.accessToken, isNull);
    });
  });
}

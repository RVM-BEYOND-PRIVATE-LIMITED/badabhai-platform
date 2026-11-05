import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/auth/authed_client.dart';
import 'package:badabhai_worker_app/core/auth/device_id.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/reauth_signal.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/auth/worker_suspended_signal.dart';

import 'fakes.dart';

String _suspendedBody({String? token}) => jsonEncode(<String, dynamic>{
  'statusCode': 403,
  'error': <String, dynamic>{
    'code': 'WORKER_ACCOUNT_SUSPENDED',
    'message': 'This account is suspended.',
    if (token != null) 'restricted_token': token,
  },
});

void main() {
  group('parseWorkerSuspension', () {
    test('top-level code + restricted_token', () {
      final WorkerSuspension? s = parseWorkerSuspension(403, <String, dynamic>{
        'code': 'WORKER_ACCOUNT_SUSPENDED',
        'restricted_token': 'abc',
      });
      expect(s, isNotNull);
      expect(s!.restrictedToken, 'abc');
    });

    test('real nested error envelope', () {
      final WorkerSuspension? s = parseWorkerSuspension(403, <String, dynamic>{
        'error': <String, dynamic>{
          'code': 'WORKER_ACCOUNT_SUSPENDED',
          'restricted_token': 'nested',
        },
      });
      expect(s!.restrictedToken, 'nested');
    });

    test('no token is still a suspension (buttons will be hidden)', () {
      final WorkerSuspension? s = parseWorkerSuspension(403, <String, dynamic>{
        'code': 'WORKER_ACCOUNT_SUSPENDED',
      });
      expect(s, isNotNull);
      expect(s!.restrictedToken, isNull);
    });

    test('a plain consent 403 / wrong status / wrong code never matches', () {
      expect(
        parseWorkerSuspension(403, <String, dynamic>{
          'code': 'CONSENT_REQUIRED',
        }),
        isNull,
      );
      expect(
        parseWorkerSuspension(401, <String, dynamic>{
          'code': 'WORKER_ACCOUNT_SUSPENDED',
        }),
        isNull,
      );
      expect(parseWorkerSuspension(403, null), isNull);
    });
  });

  group('HTTP seams fire the suspended signal', () {
    test('AuthedClient (refresh/auth path) fires with the token', () async {
      final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
      WorkerSuspension? fired;
      final AuthedClient client = AuthedClient(
        baseUrl: 'http://test',
        tokenStore: store,
        deviceId: DeviceIdProvider(store),
        localeStore: LocaleStore(FakePrefs()),
        reauthSignal: ReauthSignal(),
        onWorkerSuspended: (WorkerSuspension s) => fired = s,
        client: MockClient(
          (http.Request req) async =>
              http.Response(_suspendedBody(token: 'restricted-1'), 403),
        ),
        retryBackoff: Duration.zero,
      );

      final AuthResponse res = await client.send(HttpMethod.get, '/auth/me');

      expect(res.statusCode, 403, reason: 'the caller still sees the refusal');
      expect(fired?.restrictedToken, 'restricted-1');
    });

    test(
      'ApiClient (generic authenticated request) fires with no token',
      () async {
        WorkerSuspension? fired;
        final ApiClient api = ApiClient(
          baseUrl: 'http://test',
          onWorkerSuspended: (WorkerSuspension s) => fired = s,
          client: MockClient(
            (http.Request req) async => http.Response(_suspendedBody(), 403),
          ),
        );

        await expectLater(
          () => api.getConsentState(authToken: 'session'),
          throwsA(
            isA<ApiException>().having(
              (ApiException e) => e.statusCode,
              'statusCode',
              403,
            ),
          ),
        );

        expect(fired, isNotNull);
        expect(fired!.restrictedToken, isNull);
      },
    );
  });
}

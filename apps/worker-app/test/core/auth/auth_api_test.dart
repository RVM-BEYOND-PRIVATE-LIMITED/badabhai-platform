import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/auth/authed_client.dart';
import 'package:badabhai_worker_app/core/auth/device_id.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/reauth_signal.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';

import 'fakes.dart';

AuthApi _api(MockClient transport) {
  final SecureTokenStore store = SecureTokenStore(FakeSecureStore());
  final DeviceIdProvider deviceId = DeviceIdProvider(store);
  final AuthedClient client = AuthedClient(
    baseUrl: 'http://test',
    tokenStore: store,
    deviceId: deviceId,
    localeStore: LocaleStore(FakePrefs()),
    reauthSignal: ReauthSignal(),
    client: transport,
    retryBackoff: Duration.zero,
  );
  // Same provider drives both the X-Device-Id header and device_info.device_id.
  return AuthApi(client, deviceId: deviceId);
}

void main() {
  group('AuthApi error parsing', () {
    test('PIN_INVALID body → AuthFailure with code + attemptsLeft', () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'code': 'PIN_INVALID',
            'message': 'nope',
            'attempts_left': 2,
          }),
          401,
        );
      }));

      await expectLater(
        () => api.pinVerify('1234', refreshToken: 'r'),
        throwsA(isA<AuthFailure>()
            .having((AuthFailure f) => f.code, 'code', AuthErrorCode.pinInvalid)
            .having((AuthFailure f) => f.attemptsLeft, 'attemptsLeft', 2)),
      );
    });

    test('PIN_LOCKED body → AuthFailure carries retryAfter', () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'code': 'PIN_LOCKED',
            'retry_after_seconds': 30,
          }),
          429,
        );
      }));

      await expectLater(
        () => api.pinVerify('1234', refreshToken: 'r'),
        throwsA(isA<AuthFailure>()
            .having((AuthFailure f) => f.code, 'code', AuthErrorCode.pinLocked)
            .having((AuthFailure f) => f.retryAfter, 'retryAfter',
                const Duration(seconds: 30))),
      );
    });

    test('a 4xx with no code falls back to UNKNOWN', () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        return http.Response(jsonEncode(<String, dynamic>{}), 400);
      }));

      await expectLater(
        () => api.otpRequest('+910000000000'),
        throwsA(isA<AuthFailure>()
            .having((AuthFailure f) => f.code, 'code', AuthErrorCode.unknown)),
      );
    });

    test('otpVerify parses worker flags + tokens (real LoginResponse keys)',
        () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'worker_id': 'w-1',
            'is_new_worker': true,
            'pin_set': false,
            'access_token': 'a-1',
            'refresh_token': 'r-1',
            'expires_in_seconds': 900,
          }),
          200,
        );
      }));

      final OtpVerifyResult result = await api.otpVerify('+910000000000', '123456');

      expect(result.workerId, 'w-1');
      expect(result.isNewUser, isTrue);
      expect(result.pinSet, isFalse);
      expect(result.tokens.access, 'a-1');
      expect(result.tokens.refresh, 'r-1');
      expect(
        result.tokens.accessExpiresAt.isAfter(DateTime.now()),
        isTrue,
      );
    });

    test('otpVerify sends device_info bound to the X-Device-Id device id',
        () async {
      late final Map<String, dynamic> sentBody;
      String? sentDeviceHeader;
      final AuthApi api = _api(MockClient((http.Request req) async {
        sentBody = jsonDecode(req.body) as Map<String, dynamic>;
        sentDeviceHeader = req.headers['X-Device-Id'] ?? req.headers['x-device-id'];
        return http.Response(
          jsonEncode(<String, dynamic>{
            'worker_id': 'w-1',
            'is_new_worker': false,
            'pin_set': true,
            'access_token': 'a-1',
            'refresh_token': 'r-1',
            'expires_in_seconds': 900,
          }),
          200,
        );
      }));

      await api.otpVerify('+910000000000', '123456');

      final Map<String, dynamic>? deviceInfo =
          sentBody['device_info'] as Map<String, dynamic>?;
      expect(deviceInfo, isNotNull);
      // device_info.device_id is the SAME id as the X-Device-Id header.
      expect(deviceInfo!['device_id'], isNotNull);
      expect(deviceInfo['device_id'], sentDeviceHeader);
      expect((deviceInfo['device_id'] as String).length,
          greaterThanOrEqualTo(8));
      expect(deviceInfo['platform'], isNotNull);
    });

    test('revokeDevice issues DELETE /auth/devices/{id}', () async {
      late final String method;
      late final String path;
      final AuthApi api = _api(MockClient((http.Request req) async {
        method = req.method;
        path = req.url.path;
        return http.Response('', 204);
      }));

      await api.revokeDevice('dev-123');

      expect(method, 'DELETE');
      expect(path, '/auth/devices/dev-123');
    });
  });
}

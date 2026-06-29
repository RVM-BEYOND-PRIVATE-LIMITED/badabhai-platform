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

/// A NestJS-shaped error body — `{ statusCode, message }`, NO `code` field.
String _nestError(int status, String message) =>
    jsonEncode(<String, dynamic>{'statusCode': status, 'message': message});

void main() {
  group('AuthApi error mapping (endpoint + HTTP status, no `code` on the wire)',
      () {
    test('pin/verify 401 → NEUTRAL pinVerifyFailed (no attempts/retry)',
        () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        // The real backend returns one opaque 401 with no oracle.
        return http.Response(_nestError(401, 'Unauthorized'), 401);
      }));

      await expectLater(
        () => api.pinVerify('1234', refreshToken: 'r'),
        throwsA(isA<AuthFailure>().having(
            (AuthFailure f) => f.code, 'code', AuthErrorCode.pinVerifyFailed)),
      );
    });

    test('otp/verify 401 → otpInvalid (NOT a session-expired/reauth code)',
        () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        return http.Response(_nestError(401, 'Invalid OTP'), 401);
      }));

      await expectLater(
        () => api.otpVerify('+910000000000', '000000'),
        throwsA(isA<AuthFailure>()
            .having((AuthFailure f) => f.code, 'code', AuthErrorCode.otpInvalid)
            .having((AuthFailure f) => f.isReauthRequired, 'isReauthRequired',
                isFalse)),
      );
    });

    test('otp/request 429 → otpRateLimited, 503 → unavailable', () async {
      final AuthApi rl = _api(MockClient((http.Request req) async =>
          http.Response(_nestError(429, 'Too many'), 429)));
      await expectLater(
        () => rl.otpRequest('+910000000000'),
        throwsA(isA<AuthFailure>().having(
            (AuthFailure f) => f.code, 'code', AuthErrorCode.otpRateLimited)),
      );

      final AuthApi down = _api(MockClient((http.Request req) async =>
          http.Response(_nestError(503, 'Provider down'), 503)));
      await expectLater(
        () => down.otpRequest('+910000000000'),
        throwsA(isA<AuthFailure>().having(
            (AuthFailure f) => f.code, 'code', AuthErrorCode.unavailable)),
      );
    });

    test('pin/set 400 → pinWeak (carries the server message)', () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        return http.Response(_nestError(400, 'PIN is too weak'), 400);
      }));

      await expectLater(
        () => api.pinSet('1111'),
        throwsA(isA<AuthFailure>()
            .having((AuthFailure f) => f.code, 'code', AuthErrorCode.pinWeak)
            .having((AuthFailure f) => f.message, 'message', 'PIN is too weak')),
      );
    });

    test('token/refresh 401 → reauthRequired; other → network', () async {
      final AuthApi reauth = _api(MockClient((http.Request req) async =>
          http.Response(_nestError(401, 'nope'), 401)));
      await expectLater(
        () => reauth.tokenRefresh('r'),
        throwsA(isA<AuthFailure>()
            .having((AuthFailure f) => f.code, 'code',
                AuthErrorCode.reauthRequired)
            .having((AuthFailure f) => f.isReauthRequired, 'isReauthRequired',
                isTrue)),
      );

      final AuthApi other = _api(MockClient((http.Request req) async =>
          http.Response(_nestError(500, 'boom'), 500)));
      await expectLater(
        () => other.tokenRefresh('r'),
        throwsA(isA<AuthFailure>()
            .having((AuthFailure f) => f.code, 'code', AuthErrorCode.network)),
      );
    });

    test('pin/reset/confirm 401 → otpInvalid, 400 → pinWeak, 429 → rateLimited',
        () async {
      final AuthApi badOtp = _api(MockClient((http.Request req) async =>
          http.Response(_nestError(401, 'bad otp'), 401)));
      await expectLater(
        () => badOtp.pinResetConfirm('+910000000000', '000000', '4821'),
        throwsA(isA<AuthFailure>().having(
            (AuthFailure f) => f.code, 'code', AuthErrorCode.otpInvalid)),
      );

      final AuthApi weak = _api(MockClient((http.Request req) async =>
          http.Response(_nestError(400, 'weak'), 400)));
      await expectLater(
        () => weak.pinResetConfirm('+910000000000', '123456', '1111'),
        throwsA(isA<AuthFailure>()
            .having((AuthFailure f) => f.code, 'code', AuthErrorCode.pinWeak)),
      );
    });

    test('pin/reset/request issues POST /auth/pin/reset/request {phone}',
        () async {
      late final String method;
      late final String path;
      late final Map<String, dynamic> body;
      final AuthApi api = _api(MockClient((http.Request req) async {
        method = req.method;
        path = req.url.path;
        body = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response('', 200);
      }));

      await api.pinResetRequest('+910000000000');

      expect(method, 'POST');
      expect(path, '/auth/pin/reset/request');
      expect(body['phone'], '+910000000000');
    });

    test('a 4xx the table does not special-case falls back to UNKNOWN',
        () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        return http.Response(_nestError(400, 'bad request'), 400);
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

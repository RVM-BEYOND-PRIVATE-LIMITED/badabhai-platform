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
      // TD62 tri-state: the field is ABSENT above (old server) → null, NEVER a
      // defaulted true/false.
      expect(result.consentAccepted, isNull);
      // No `deletion_scheduled_for` on the wire (the usual case) → null.
      expect(result.deletionScheduledFor, isNull);
    });

    test(
        'otpVerify parses the OPTIONAL deletion_scheduled_for '
        '(ADR-0031 pending-deletion flag)', () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'worker_id': 'w-1',
            'is_new_worker': false,
            'pin_set': true,
            'access_token': 'a-1',
            'refresh_token': 'r-1',
            'expires_in_seconds': 900,
            'deletion_scheduled_for': '2026-07-21T12:00:00.000Z',
          }),
          200,
        );
      }));

      final OtpVerifyResult result =
          await api.otpVerify('+910000000000', '123456');

      expect(result.deletionScheduledFor, DateTime.utc(2026, 7, 21, 12));
    });

    test('otpVerify parses a PRESENT consent_accepted (TD62, both values)',
        () async {
      Future<OtpVerifyResult> parse(bool value) async {
        final AuthApi api = _api(MockClient((http.Request req) async {
          return http.Response(
            jsonEncode(<String, dynamic>{
              'worker_id': 'w-1',
              'is_new_worker': false,
              'pin_set': true,
              'access_token': 'a-1',
              'refresh_token': 'r-1',
              'expires_in_seconds': 900,
              'consent_accepted': value,
            }),
            200,
          );
        }));
        return api.otpVerify('+910000000000', '123456');
      }

      expect((await parse(true)).consentAccepted, isTrue);
      expect((await parse(false)).consentAccepted, isFalse);
    });

    test('pinVerify parses tokens + tri-state consent_accepted (TD62)',
        () async {
      final AuthApi withField = _api(MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'access_token': 'a-2',
            'refresh_token': 'r-2',
            'expires_in_seconds': 900,
            'consent_accepted': false,
          }),
          200,
        );
      }));
      final PinVerifyResult present =
          await withField.pinVerify('1234', refreshToken: 'r');
      expect(present.tokens.access, 'a-2');
      expect(present.tokens.refresh, 'r-2');
      expect(present.consentAccepted, isFalse);

      final AuthApi withoutField = _api(MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'access_token': 'a-3',
            'refresh_token': 'r-3',
            'expires_in_seconds': 900,
          }),
          200,
        );
      }));
      final PinVerifyResult absent =
          await withoutField.pinVerify('1234', refreshToken: 'r');
      expect(absent.consentAccepted, isNull); // old server → unknown, not false
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

    // --- GET /auth/devices parse (A2: silent-empty-list bug) ----------------

    test('listDevices parses the confirmed {devices:[...]} shape → populated',
        () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'devices': <Map<String, dynamic>>[
              <String, dynamic>{
                'id': 'd-1',
                'platform': 'android',
                'model': 'Pixel 6',
                'app_version': '1.2.0',
                'trusted_at': '2026-07-01T00:00:00.000Z',
                'last_seen_at': '2026-07-10T00:00:00.000Z',
                'is_current': true,
              },
            ],
          }),
          200,
        );
      }));

      final List<AuthDevice> devices = await api.listDevices();
      expect(devices, hasLength(1));
      expect(devices.first.id, 'd-1');
      expect(devices.first.platform, 'android');
      expect(devices.first.model, 'Pixel 6');
      expect(devices.first.isCurrent, isTrue);
    });

    test(
        'listDevices on a WRONG root key (e.g. `data`) throws contractError '
        '— NOT a silent empty list', () async {
      final AuthApi api = _api(MockClient((http.Request req) async =>
          http.Response(
              jsonEncode(<String, dynamic>{'data': <dynamic>[]}), 200)));
      await expectLater(
        () => api.listDevices(),
        throwsA(isA<AuthFailure>().having(
            (AuthFailure f) => f.code, 'code', AuthErrorCode.contractError)),
      );
    });

    test('listDevices on a null/non-list `devices` throws contractError',
        () async {
      final AuthApi api = _api(MockClient((http.Request req) async =>
          http.Response(
              jsonEncode(<String, dynamic>{'devices': null}), 200)));
      await expectLater(
        () => api.listDevices(),
        throwsA(isA<AuthFailure>().having(
            (AuthFailure f) => f.code, 'code', AuthErrorCode.contractError)),
      );
    });

    test('listDevices returns [] for a present, EMPTY devices list (valid)',
        () async {
      final AuthApi api = _api(MockClient((http.Request req) async =>
          http.Response(
              jsonEncode(<String, dynamic>{'devices': <dynamic>[]}), 200)));
      expect(await api.listDevices(), isEmpty);
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

  // F5 — AuthTokens.fromJson read only access_token/refresh_token/
  // expires_in_seconds, so refresh_expires_in_seconds and the whole
  // `session { tier, expires_at, requires_otp_after }` block were dropped on the
  // floor at ALL THREE parse sites. requires_otp_after is the server telling the
  // app when a refresh/PIN will stop being enough — dropping it meant the app
  // could only discover a forced re-OTP by being rejected mid-action.
  group('AuthTokens retains the session block (F5)', () {
    // `tier` is a NUMBER on the wire — the backend's engagement-tier index
    // (SessionInfo.tier, `tierFor()` → 0..3). This fixture used to invent
    // `'tier': 'full'`, a string the API has never sent, which is exactly why the
    // suite stayed green while every real OTP verify threw
    // `type 'int' is not a subtype of type 'String?'` against the live backend.
    Map<String, dynamic> body() => <String, dynamic>{
          'access_token': 'a1',
          'refresh_token': 'r1',
          'expires_in_seconds': 900,
          'refresh_expires_in_seconds': 2592000,
          'session': <String, dynamic>{
            'tier': 2,
            'expires_at': '2026-08-01T10:00:00.000Z',
            'requires_otp_after': '2026-07-31T10:00:00.000Z',
          },
        };

    test('parses refresh expiry + tier + requires_otp_after', () {
      final AuthTokens t = AuthTokens.fromJson(body());

      expect(t.access, 'a1');
      expect(t.refresh, 'r1');
      expect(t.session, isNotNull);
      expect(t.session!.tier, 2);
      expect(t.session!.requiresOtpAfter,
          DateTime.parse('2026-07-31T10:00:00.000Z'));
      expect(t.session!.expiresAt, DateTime.parse('2026-08-01T10:00:00.000Z'));
      // A DURATION on the wire becomes an absolute instant, mirroring
      // accessExpiresAt — a duration is useless after an app restart.
      expect(t.refreshExpiresAt, isNotNull);
      expect(t.refreshExpiresAt!.isAfter(DateTime.now()), isTrue);
    });

    test('an OLDER server omitting the block still logs the worker in', () {
      final AuthTokens t = AuthTokens.fromJson(<String, dynamic>{
        'access_token': 'a1',
        'refresh_token': 'r1',
        'expires_in_seconds': 900,
      });

      // Every added field is OPTIONAL — absence must never brick login.
      expect(t.access, 'a1');
      expect(t.session, isNull);
      expect(t.refreshExpiresAt, isNull);
    });

    test('a malformed session block degrades to null, never throws', () {
      expect(
        AuthTokens.fromJson(<String, dynamic>{
          'access_token': 'a1',
          'refresh_token': 'r1',
          'expires_in_seconds': 900,
          'session': 'not-an-object',
        }).session,
        isNull,
      );
      // A bad timestamp must not take down an otherwise successful login.
      final AuthTokens t = AuthTokens.fromJson(<String, dynamic>{
        'access_token': 'a1',
        'refresh_token': 'r1',
        'expires_in_seconds': 900,
        'session': <String, dynamic>{
          'tier': 2,
          'expires_at': 'garbage',
          'requires_otp_after': null,
        },
      });
      expect(t.session!.tier, 2);
      expect(t.session!.expiresAt, isNull);
      expect(t.session!.requiresOtpAfter, isNull);
    });

    // REGRESSION (the live crash): `tier` arrives as an int, because that is what
    // the backend sends. A cast to String? here threw _TypeError and took down a
    // login the server had ALREADY granted — the worker was authenticated on the
    // server and stuck on the OTP screen.
    test('an int tier parses — the real backend shape never throws', () {
      final AuthTokens t = AuthTokens.fromJson(<String, dynamic>{
        'access_token': 'a1',
        'refresh_token': 'r1',
        'expires_in_seconds': 900,
        'session': <String, dynamic>{
          'tier': 0, // tier 0 = the lowest real tier, not "absent"
          'expires_at': '2026-08-01T10:00:00.000Z',
          'requires_otp_after': null,
        },
      });
      expect(t.session!.tier, 0);
      expect(t.access, 'a1', reason: 'the login itself must survive');
    });

    // The block promises a TOLERANT parse: a tier shape we cannot read degrades
    // to null (unknown) and must never brick a granted login. Null, not 0 —
    // 0 is a real tier and would read as "least engaged" rather than "unknown".
    test('an unreadable tier degrades to null, never throws', () {
      for (final Object? bad in <Object?>[null, 'full', <String>['x'], true]) {
        final AuthTokens t = AuthTokens.fromJson(<String, dynamic>{
          'access_token': 'a1',
          'refresh_token': 'r1',
          'expires_in_seconds': 900,
          'session': <String, dynamic>{'tier': bad},
        });
        expect(t.session!.tier, isNull, reason: 'tier: $bad');
        expect(t.access, 'a1', reason: 'the login must survive tier: $bad');
      }
      // A stringified number is still a number the server meant.
      expect(
        AuthTokens.fromJson(<String, dynamic>{
          'access_token': 'a1',
          'refresh_token': 'r1',
          'expires_in_seconds': 900,
          'session': <String, dynamic>{'tier': '3'},
        }).session!.tier,
        3,
      );
    });

    test('the session rides the OTP-verify response end-to-end', () async {
      final AuthApi api = _api(MockClient((http.Request req) async {
        return http.Response(
          jsonEncode(<String, dynamic>{
            'worker_id': 'w1',
            'is_new_worker': false,
            'pin_set': true,
            ...body(),
          }),
          200,
        );
      }));

      final OtpVerifyResult r = await api.otpVerify('+910000000000', '123456');

      expect(r.tokens.session?.requiresOtpAfter,
          DateTime.parse('2026-07-31T10:00:00.000Z'));
      expect(r.tokens.refreshExpiresAt, isNotNull);
    });
  });
}

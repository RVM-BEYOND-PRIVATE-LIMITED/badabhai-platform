import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// The RESERVED account-deleted contract: a call made with a VALID worker token
/// whose row no longer exists server-side → HTTP 410 Gone carrying
/// `code == WORKER_ACCOUNT_DELETED`.
///
/// The wire body is the API's standard envelope — the global `AllExceptionsFilter`
/// nests the thrown payload under `error`, so the REAL shape is
/// `{ statusCode: 410, error: { code: 'WORKER_ACCOUNT_DELETED', message } }`. The
/// client must fire [onAccountDeleted] on that, STILL throw the [ApiException]
/// (never swallow the in-flight call), and NEVER fire on a generic error — a 500,
/// a bare 410, another 410 code, or a 401 — because a false destructive logout of
/// a live worker is unacceptable at scale.
void main() {
  group('ApiClient WORKER_ACCOUNT_DELETED (410) detection', () {
    ApiClient build(
      Future<http.Response> Function(http.Request req) handler, {
      void Function()? onAccountDeleted,
    }) =>
        ApiClient(
          baseUrl: 'http://test',
          onAccountDeleted: onAccountDeleted,
          client: MockClient(handler),
        );

    http.Response body410(Map<String, dynamic> json, [int status = 410]) =>
        http.Response(jsonEncode(json), status);

    test('REAL envelope: 410 + { error: { code } } fires the callback AND still '
        'throws ApiException(410)', () async {
      int fired = 0;
      final ApiClient api = build(
        (http.Request req) async => body410(<String, dynamic>{
          'statusCode': 410,
          'error': <String, dynamic>{
            'code': 'WORKER_ACCOUNT_DELETED',
            'message': 'This account no longer exists.',
          },
          'requestId': 'r1',
          'path': '/chat/session',
        }),
        onAccountDeleted: () => fired++,
      );

      await expectLater(
        api.startSession(authToken: 'valid-token'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 410)),
        reason: 'the in-flight call must still fail cleanly, never be swallowed',
      );
      expect(fired, 1, reason: 'exactly one hard-logout signal on the real shape');
    });

    test('also fires on a TOP-LEVEL { code } 410 (defensive to a flatter shape)',
        () async {
      int fired = 0;
      final ApiClient api = build(
        (http.Request req) async =>
            body410(<String, dynamic>{'code': 'WORKER_ACCOUNT_DELETED'}),
        onAccountDeleted: () => fired++,
      );
      await expectLater(api.startSession(authToken: 'valid-token'),
          throwsA(isA<ApiException>()));
      expect(fired, 1);
    });

    test('a bare 410 (no code, either shape) does NOT fire', () async {
      int fired = 0;
      final ApiClient api = build(
        (http.Request req) async => body410(<String, dynamic>{
          'statusCode': 410,
          'error': <String, dynamic>{'message': 'Gone.'},
        }),
        onAccountDeleted: () => fired++,
      );
      await expectLater(api.startSession(authToken: 'valid-token'),
          throwsA(isA<ApiException>()));
      expect(fired, 0, reason: 'a bare 410 must never log the worker out');
    });

    test('a 410 with a DIFFERENT code (nested) does NOT fire', () async {
      int fired = 0;
      final ApiClient api = build(
        (http.Request req) async => body410(<String, dynamic>{
          'statusCode': 410,
          'error': <String, dynamic>{'code': 'RESOURCE_GONE'},
        }),
        onAccountDeleted: () => fired++,
      );
      await expectLater(api.startSession(authToken: 'valid-token'),
          throwsA(isA<ApiException>()));
      expect(fired, 0, reason: '410 is reserved for WORKER_ACCOUNT_DELETED only');
    });

    test('a 500 carrying the code does NOT fire — a generic server error is '
        'never account-deletion', () async {
      int fired = 0;
      final ApiClient api = build(
        (http.Request req) async => body410(<String, dynamic>{
          'statusCode': 500,
          'error': <String, dynamic>{'code': 'WORKER_ACCOUNT_DELETED'},
        }, 500),
        onAccountDeleted: () => fired++,
      );
      await expectLater(api.startSession(authToken: 'valid-token'),
          throwsA(isA<ApiException>()));
      expect(fired, 0, reason: 'the status must be exactly 410');
    });

    test('a 401 carrying the code does NOT fire (silent reauth, not logout)',
        () async {
      int fired = 0;
      final ApiClient api = build(
        (http.Request req) async => body410(<String, dynamic>{
          'error': <String, dynamic>{'code': 'WORKER_ACCOUNT_DELETED'},
        }, 401),
        onAccountDeleted: () => fired++,
      );
      await expectLater(
        api.startSession(authToken: 'valid-token'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 401)),
      );
      expect(fired, 0);
    });

    test('with no callback wired, a 410 + code behaves exactly as before',
        () async {
      final ApiClient api = build(
        (http.Request req) async => body410(<String, dynamic>{
          'error': <String, dynamic>{'code': 'WORKER_ACCOUNT_DELETED'},
        }),
      );
      await expectLater(
        api.startSession(authToken: 'valid-token'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 410)),
      );
    });
  });
}

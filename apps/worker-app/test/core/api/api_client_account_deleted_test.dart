import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// The RESERVED account-deleted contract: a call made with a VALID worker token
/// whose row no longer exists server-side → HTTP 410 Gone with body
/// `{ "code": "WORKER_ACCOUNT_DELETED" }`. The client must fire [onAccountDeleted]
/// ONLY on `statusCode == 410 && code == 'WORKER_ACCOUNT_DELETED'`, and must STILL
/// throw the [ApiException] so the in-flight call fails cleanly (never swallowed).
/// A false destructive logout — on a bare 410, another 410 code, or a 401 — is
/// unacceptable.
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

    test('410 + WORKER_ACCOUNT_DELETED fires the callback AND throws '
        'ApiException(410)', () async {
      int fired = 0;
      final ApiClient api = build(
        (http.Request req) async => http.Response(
          jsonEncode(<String, dynamic>{
            'code': 'WORKER_ACCOUNT_DELETED',
            'message': 'This account has been deleted.',
          }),
          410,
        ),
        onAccountDeleted: () => fired++,
      );

      await expectLater(
        api.startSession(authToken: 'valid-token'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 410)),
        reason: 'the in-flight call must still fail cleanly, never be swallowed',
      );
      expect(fired, 1, reason: 'exactly one hard-logout signal');
    });

    test('a bare 410 (no code) does NOT fire — no false destructive logout',
        () async {
      int fired = 0;
      final ApiClient api = build(
        (http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{}), 410),
        onAccountDeleted: () => fired++,
      );

      await expectLater(
        api.startSession(authToken: 'valid-token'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 410)),
      );
      expect(fired, 0, reason: 'a bare 410 must never log the worker out');
    });

    test('a 410 with a DIFFERENT code does NOT fire', () async {
      int fired = 0;
      final ApiClient api = build(
        (http.Request req) async => http.Response(
          jsonEncode(<String, dynamic>{'code': 'RESOURCE_GONE'}),
          410,
        ),
        onAccountDeleted: () => fired++,
      );

      await expectLater(
        api.startSession(authToken: 'valid-token'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 410)),
      );
      expect(fired, 0, reason: '410 is reserved for WORKER_ACCOUNT_DELETED only');
    });

    test('a 401 is unchanged — never fires account-deleted even with the code',
        () async {
      int fired = 0;
      final ApiClient api = build(
        // Same code, wrong status: the predicate is BOTH, so this must not fire.
        (http.Request req) async => http.Response(
          jsonEncode(<String, dynamic>{'code': 'WORKER_ACCOUNT_DELETED'}),
          401,
        ),
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
        (http.Request req) async => http.Response(
          jsonEncode(<String, dynamic>{'code': 'WORKER_ACCOUNT_DELETED'}),
          410,
        ),
      );

      await expectLater(
        api.startSession(authToken: 'valid-token'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 410)),
      );
    });
  });
}

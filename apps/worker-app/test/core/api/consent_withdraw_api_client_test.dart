import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// The wire contract for `POST /consent/withdraw`, reconciled with the real
/// backend (apps/api/src/consent/consent.controller.ts:41 — WorkerAuthGuard, no
/// body, HttpCode 200, `{ ok: true }`). Mirrors [ApiClient.acceptConsent].
void main() {
  group('ApiClient.withdrawConsent (DPDP consent withdrawal)', () {
    test('POSTs /consent/withdraw with the bearer and an EMPTY body', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{'ok': true}),
            200,
          );
        }),
      );

      await api.withdrawConsent(authToken: 'tok');

      expect(captured.method, 'POST');
      expect(captured.url.path, '/consent/withdraw');
      expect(captured.headers['authorization'], 'Bearer tok');
      // The subject is the session worker, never a body id — no worker_id, no
      // purposes: nothing but an empty object.
      expect(jsonDecode(captured.body), isEmpty);
    });

    test('surfaces a non-2xx as an ApiException (honest failure)', () {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{'message': 'no'}), 401)),
      );

      expect(
        () => api.withdrawConsent(authToken: 'tok'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 401)),
      );
    });
  });
}

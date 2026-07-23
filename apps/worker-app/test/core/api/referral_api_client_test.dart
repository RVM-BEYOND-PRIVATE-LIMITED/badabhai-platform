import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

void main() {
  group('ApiClient.attributeReferral (POST /referrals/attribute)', () {
    test('POSTs the code with the bearer; body is exactly {code}', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          // Neutral no-oracle response — the client ignores the body.
          return http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200);
        }),
      );

      await api.attributeReferral(authToken: 'tok', code: 'abcdef012345');

      expect(captured.method, 'POST');
      expect(captured.url.path, '/referrals/attribute');
      expect(captured.headers['authorization'], 'Bearer tok');
      // The opaque code is the ONLY thing sent — no worker id, no PII.
      expect(jsonDecode(captured.body), <String, dynamic>{'code': 'abcdef012345'});
    });

    test('ignores the neutral response body (returns normally on {ok:true})',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{'ok': true}), 200)),
      );

      // Completes without throwing and yields nothing to inspect (Future<void>).
      await expectLater(
        api.attributeReferral(authToken: 'tok', code: 'abcdef012345'),
        completes,
      );
    });

    test('surfaces a non-2xx as an ApiException (caller swallows it)', () {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{'message': 'no'}), 403)),
      );

      expect(
        () => api.attributeReferral(authToken: 'tok', code: 'abcdef012345'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 403)),
      );
    });
  });
}

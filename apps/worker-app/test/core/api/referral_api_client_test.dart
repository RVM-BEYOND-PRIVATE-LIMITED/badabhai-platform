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

  group('ApiClient.lookupReferralHelperName (GET /referrals/helper)', () {
    test('sends the code as the query and NO bearer; returns the name', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{'display_name': 'Acme Staffing'}),
            200,
          );
        }),
      );

      final String? name =
          await api.lookupReferralHelperName(code: 'abcdef012345');

      expect(name, 'Acme Staffing');
      expect(captured.method, 'GET');
      expect(captured.url.path, '/referrals/helper');
      expect(captured.url.queryParameters, <String, String>{
        'code': 'abcdef012345',
      });
      expect(captured.headers.containsKey('authorization'), isFalse,
          reason: 'the screen comes before sign-in; no token is sent');
    });

    test('a null name and the switch-off 404 both read as null', () async {
      final ApiClient nullBody = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{'display_name': null}), 200)),
      );
      expect(
          await nullBody.lookupReferralHelperName(code: 'abcdef012345'), isNull);

      final ApiClient off = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{'message': 'Not found'}), 404)),
      );
      expect(await off.lookupReferralHelperName(code: 'abcdef012345'), isNull);
    });
  });
}

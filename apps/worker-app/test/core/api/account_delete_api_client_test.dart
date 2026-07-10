import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

void main() {
  group('ApiClient account-delete methods (A4)', () {
    test('requestAccountDelete POSTs the request route with bearer, no body',
        () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(
                <String, dynamic>{'success': true, 'resend_in_seconds': 30}),
            200,
          );
        }),
      );

      final AccountDeleteRequestResult res =
          await api.requestAccountDelete(authToken: 'tok');

      expect(captured.method, 'POST');
      expect(captured.url.path, '/auth/account/delete/request');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(jsonDecode(captured.body), isEmpty);
      expect(res.success, isTrue);
      expect(res.resendInSeconds, 30);
    });

    test('confirmAccountDelete POSTs the otp; 204 (empty body) is OK', () async {
      late http.Request captured;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          captured = req;
          return http.Response('', 204);
        }),
      );

      await api.confirmAccountDelete(authToken: 'tok', otp: '1234');

      expect(captured.method, 'POST');
      expect(captured.url.path, '/auth/account/delete/confirm');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(jsonDecode(captured.body), <String, dynamic>{'otp': '1234'});
    });

    test('confirmAccountDelete surfaces a 401 as an ApiException (bad OTP)', () {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async =>
            http.Response(jsonEncode(<String, dynamic>{'message': 'bad'}), 401)),
      );

      expect(
        () => api.confirmAccountDelete(authToken: 'tok', otp: '0000'),
        throwsA(isA<ApiException>()
            .having((ApiException e) => e.statusCode, 'statusCode', 401)),
      );
    });
  });
}

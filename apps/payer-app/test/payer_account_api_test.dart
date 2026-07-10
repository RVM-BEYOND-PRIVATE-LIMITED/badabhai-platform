import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/payer_account_api.dart';

/// Guards on `GET/PATCH /payer/me`: a non-2xx must THROW (so AccountCubit shows
/// the real error) rather than decode into a blank [PayerMe] emitted as "ready".
({HttpPayerAccountApi api, List<http.Request> seen}) _harness(
  http.Response Function(http.Request) handler,
) {
  final List<http.Request> seen = <http.Request>[];
  final MockClient client = MockClient((http.Request req) async {
    seen.add(req);
    return handler(req);
  });
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // ignore: discarded_futures
  tokens.save(accessToken: 'tok-abc', payerId: 'p', role: 'employer');
  final PayerHttp httpClient = PayerHttp(
    baseUrl: 'http://api.test',
    tokenStore: tokens,
    client: client,
  );
  return (api: HttpPayerAccountApi(httpClient), seen: seen);
}

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status,
        headers: <String, String>{'content-type': 'application/json'});

void main() {
  group('HttpPayerAccountApi — /payer/me guards', () {
    test('fetchMe 200 parses the PII-light account', () async {
      final h = _harness((_) => _json(<String, dynamic>{
            'id': 'p-1',
            'role': 'employer',
            'status': 'active',
            'orgName': 'Kalyani Industries',
            'email': 'demo@badabhai.in',
            'phoneLast4': '3210',
          }));

      final PayerMe me = await h.api.fetchMe();

      expect(me.orgName, 'Kalyani Industries');
      expect(me.phoneLast4, '3210');
      expect(h.seen.single.url.path, '/payer/me');
    });

    test('fetchMe 500 → PayerApiException (never a blank account as ready)',
        () async {
      final h = _harness((_) => _json(<String, dynamic>{}, 500));
      await expectLater(
        h.api.fetchMe(),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'statusCode', 500)),
      );
    });

    test('updateMe 200 echoes the edited fields', () async {
      final h = _harness((_) => _json(<String, dynamic>{
            'id': 'p-1',
            'role': 'employer',
            'status': 'active',
            'orgName': 'New Name Pvt Ltd',
            'email': 'demo@badabhai.in',
            'phoneLast4': '9911',
          }));

      final PayerMe me = await h.api.updateMe(orgName: 'New Name Pvt Ltd');

      expect(me.orgName, 'New Name Pvt Ltd');
      final http.Request req = h.seen.single;
      expect(req.method, 'PATCH');
      expect(jsonDecode(req.body),
          <String, dynamic>{'orgName': 'New Name Pvt Ltd'});
    });

    test('updateMe 400 (rejected PATCH) → PayerApiException, no blanking',
        () async {
      final h = _harness((_) => _json(<String, dynamic>{'message': 'bad'}, 400));
      await expectLater(
        h.api.updateMe(orgName: 'X'),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.isBadRequest, 'isBadRequest', true)),
      );
    });
  });
}

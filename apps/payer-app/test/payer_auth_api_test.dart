import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_auth_api.dart';
import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/session/app_session.dart';

/// Builds a [PayerAuthApi] + [PayerTokenStore] over a [MockClient] that records
/// the requests it sees, so we can assert path / body / bearer.
({
  HttpPayerAuthApi api,
  PayerTokenStore tokens,
  List<http.Request> seen,
}) _harness(http.Response Function(http.Request) handler) {
  final List<http.Request> seen = <http.Request>[];
  final MockClient client = MockClient((http.Request req) async {
    seen.add(req);
    return handler(req);
  });
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  final PayerHttp httpClient = PayerHttp(
    baseUrl: 'http://api.test',
    tokenStore: tokens,
    client: client,
  );
  return (api: HttpPayerAuthApi(httpClient), tokens: tokens, seen: seen);
}

void main() {
  group('PayerAuthApi (real, /payer/*)', () {
    test('signup posts {role,email,org_name} to /payer/signup', () async {
      final h = _harness((_) => http.Response('{}', 201));
      await h.api.signup(role: 'agent', email: 'a@b.com', orgName: 'Apex');

      final http.Request req = h.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/signup');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body, <String, dynamic>{
        'role': 'agent',
        'email': 'a@b.com',
        'org_name': 'Apex',
      });
      // Never a body payer_id.
      expect(body.containsKey('payer_id'), isFalse);
    });

    test('signup passes a non-empty org_name (backend requires min 1)',
        () async {
      final h = _harness((_) => http.Response('{}', 201));
      await h.api.signup(role: 'employer', email: 'c@d.com', orgName: 'Acme');

      final Map<String, dynamic> body =
          jsonDecode(h.seen.single.body) as Map<String, dynamic>;
      expect(body['org_name'], 'Acme');
      expect((body['org_name'] as String).isNotEmpty, isTrue);
    });

    test('signup throws PayerApiException on a non-2xx (400 rejected)',
        () async {
      final h = _harness((_) => http.Response('{}', 400));
      await expectLater(
        h.api.signup(role: 'employer', email: 'a@b.com', orgName: ''),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.isBadRequest, 'isBadRequest', true)),
      );
    });

    test('loginRequest posts {email} to /payer/login/request', () async {
      final h = _harness((_) => http.Response('{}', 200));
      await h.api.loginRequest(email: 'a@b.com');

      final http.Request req = h.seen.single;
      expect(req.url.path, '/payer/login/request');
      expect(jsonDecode(req.body), <String, dynamic>{'email': 'a@b.com'});
    });

    test('loginVerify posts {email,code} and parses the result', () async {
      final h = _harness(
        (_) => http.Response(
          jsonEncode(<String, dynamic>{
            'access_token': 'tok-123',
            'token_type': 'Bearer',
            'expires_in_seconds': 3600,
            'payer_id': 'payer-9',
            'role': 'agent',
            'is_new_payer': true,
          }),
          200,
        ),
      );

      final PayerLoginResult result =
          await h.api.loginVerify(email: 'a@b.com', code: '654321');

      final http.Request req = h.seen.single;
      expect(req.url.path, '/payer/login/verify');
      expect(jsonDecode(req.body),
          <String, dynamic>{'email': 'a@b.com', 'code': '654321'});

      expect(result.accessToken, 'tok-123');
      expect(result.payerId, 'payer-9');
      expect(result.role, 'agent');
      expect(result.isNewPayer, isTrue);
      // Wire role 'agent' → PayerRole.agency.
      expect(result.payerRole, PayerRole.agency);
    });

    test('refresh attaches the bearer and returns the new token', () async {
      final h = _harness(
        (_) => http.Response(
          jsonEncode(<String, dynamic>{'access_token': 'tok-fresh'}),
          200,
        ),
      );
      await h.tokens.save(
        accessToken: 'tok-old',
        payerId: 'p',
        role: 'employer',
      );

      final String? token = await h.api.refresh();

      final http.Request req = h.seen.single;
      expect(req.url.path, '/payer/refresh');
      expect(req.headers['authorization'], 'Bearer tok-old');
      expect(token, 'tok-fresh');
    });

    test('logout posts /payer/logout and tolerates a 204', () async {
      final h = _harness((_) => http.Response('', 204));
      await h.tokens.save(accessToken: 't', payerId: 'p', role: 'employer');

      await h.api.logout();

      expect(h.seen.single.url.path, '/payer/logout');
    });
  });

  group('PayerHttp 401 handling', () {
    test('a 401 on an authed call clears the token + fires onReauth', () async {
      bool reauthed = false;
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 't', payerId: 'p', role: 'employer');
      final MockClient client =
          MockClient((http.Request req) async => http.Response('', 401));
      final PayerHttp httpClient = PayerHttp(
        baseUrl: 'http://api.test',
        tokenStore: tokens,
        client: client,
        onReauth: () => reauthed = true,
      );

      final PayerResponse res =
          await httpClient.send(PayerMethod.get, '/payer/credits');

      expect(res.statusCode, 401);
      expect(reauthed, isTrue);
      expect(tokens.hasSession, isFalse);
    });
  });

  group('MockPayerAuthApi', () {
    test('any code verifies and echoes the chosen role', () async {
      final MockPayerAuthApi api = MockPayerAuthApi();
      api.setRole('agent');
      final PayerLoginResult result =
          await api.loginVerify(email: 'x@y.com', code: '000000');
      expect(result.accessToken, isNotEmpty);
      expect(result.payerRole, PayerRole.agency);
    });
  });
}

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

    test('signup sends a phone-only contact when no email is given (#2497)',
        () async {
      final h = _harness((_) => http.Response('{}', 200));
      await h.api.signup(
        role: 'employer',
        orgName: 'Acme',
        phone: '+918946991002',
      );

      expect(jsonDecode(h.seen.single.body), <String, dynamic>{
        'role': 'employer',
        'org_name': 'Acme',
        'phone': '+918946991002',
      });
    });

    test('signup rejects an empty contact before touching the wire', () async {
      final h = _harness((_) => http.Response('{}', 200));
      await expectLater(
        h.api.signup(role: 'employer', orgName: 'Acme'),
        throwsArgumentError,
      );
      expect(h.seen, isEmpty);
    });

    test('setPassword uses the explicit verify token, not the stored one '
        '(#2497)', () async {
      final h = _harness((_) => http.Response(
            '',
            204,
            // Even if the server offers a rolling token, this pre-session call
            // must NOT persist one.
            headers: <String, String>{'x-session-token': 'rolling-token'},
          ));
      await h.api.setPassword(
        accessToken: 'verify-token',
        password: 'Secret123',
      );

      final http.Request req = h.seen.single;
      expect(req.url.path, '/payer/password/set');
      expect(req.headers['authorization'], 'Bearer verify-token');
      expect(jsonDecode(req.body), <String, dynamic>{'password': 'Secret123'});
      // The session is NOT persisted by this call.
      expect(h.tokens.hasSession, isFalse);
    });

    test('setPassword throws on a rejected password', () async {
      final h = _harness((_) => http.Response('{}', 400));
      await expectLater(
        h.api.setPassword(accessToken: 'verify-token', password: 'short'),
        throwsA(isA<PayerApiException>()),
      );
    });

    test('loginWithPassword posts {identifier,password} to /payer/login/password',
        () async {
      final h = _harness(
        (_) => http.Response(
          jsonEncode(<String, dynamic>{
            'access_token': 'tok-pw',
            'payer_id': 'payer-7',
            'role': 'employer',
            'is_new_payer': false,
          }),
          200,
        ),
      );

      final PayerPasswordLoginOutcome outcome = await h.api.loginWithPassword(
        identifier: 'Acme Works',
        password: 'Secret123',
      );

      final http.Request req = h.seen.single;
      expect(req.url.path, '/payer/login/password');
      expect(jsonDecode(req.body),
          <String, dynamic>{'identifier': 'Acme Works', 'password': 'Secret123'});
      expect(req.headers.containsKey('authorization'), isFalse);
      final PayerLoginResult result = (outcome as PayerPasswordSignedIn).session;
      expect(result.accessToken, 'tok-pw');
      expect(result.payerRole, PayerRole.company);
    });

    test('a wrong password / unknown identifier surfaces as a neutral 401',
        () async {
      final h = _harness((_) => http.Response('{}', 401));
      await expectLater(
        h.api.loginWithPassword(identifier: 'a@b.com', password: 'nope'),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'status', 401)),
      );
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

    test('walks signup → password → login by email, phone or company name',
        () async {
      final MockPayerAuthApi api = MockPayerAuthApi();
      await api.signup(
        role: 'agent',
        orgName: 'Apex Staffing',
        phone: '+918946991002',
      );
      await api.setPassword(
        accessToken: 'mock-payer-token',
        password: 'Secret123',
      );

      for (final String identifier in <String>[
        '+918946991002',
        'apex staffing',
        'APEX STAFFING',
      ]) {
        final PayerPasswordLoginOutcome outcome = await api.loginWithPassword(
          identifier: identifier,
          password: 'Secret123',
        );
        expect((outcome as PayerPasswordSignedIn).session.payerRole,
            PayerRole.agency,
            reason: identifier);
      }
    });

    test('the mock rejects a wrong password with a 401', () async {
      final MockPayerAuthApi api = MockPayerAuthApi();
      await api.signup(
        role: 'employer',
        orgName: 'Acme',
        email: 'a@b.com',
      );
      await api.setPassword(
        accessToken: 'mock-payer-token',
        password: 'Secret123',
      );

      await expectLater(
        api.loginWithPassword(identifier: 'a@b.com', password: 'wrong'),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'status', 401)),
      );
    });
  });

  // ---- #2597: admin-issued temporary password (backend #2563 / PR #2628) ----
  group('#2597 — loginWithPassword forced change', () {
    http.Response json(Object body, [int status = 200]) =>
        http.Response(jsonEncode(body), status);

    test('password_change_required is NOT a session (nothing stored)',
        () async {
      final h = _harness(
          (_) => json(<String, dynamic>{'status': 'password_change_required'}));

      final PayerPasswordLoginOutcome outcome = await h.api
          .loginWithPassword(identifier: 'owner@acme.in', password: 'Temp9xQ2');

      expect(outcome, isA<PayerPasswordChangeRequired>());
      expect(h.tokens.hasSession, isFalse);
    });

    test('password_change_required wins even if a token rides along',
        () async {
      final h = _harness((_) => json(<String, dynamic>{
            'status': 'password_change_required',
            'access_token': 'tok-should-not-be-used',
          }));

      final PayerPasswordLoginOutcome outcome = await h.api
          .loginWithPassword(identifier: 'owner@acme.in', password: 'Temp9xQ2');

      expect(outcome, isA<PayerPasswordChangeRequired>());
    });

    test('FAIL CLOSED: a 2xx without a non-empty access_token throws',
        () async {
      for (final Map<String, dynamic> body in <Map<String, dynamic>>[
        <String, dynamic>{},
        <String, dynamic>{'access_token': ''},
        <String, dynamic>{'access_token': 42},
        <String, dynamic>{'access_token': null, 'payer_id': 'p', 'role': 'agent'},
        <String, dynamic>{'status': 'something_else'},
      ]) {
        final h = _harness((_) => json(body));
        await expectLater(
          h.api.loginWithPassword(identifier: 'a@b.com', password: 'Secret123'),
          throwsA(isA<PayerApiException>()
              .having((PayerApiException e) => e.statusCode, 'status', 200)),
          reason: '$body',
        );
        expect(h.tokens.hasSession, isFalse, reason: '$body');
      }
    });

    test('the resend carries new_password and a real session signs in',
        () async {
      final h = _harness((_) => json(<String, dynamic>{
            'access_token': 'tok-new',
            'token_type': 'Bearer',
            'expires_in_seconds': 3600,
            'payer_id': 'payer-3',
            'role': 'agent',
            'is_new_payer': false,
          }));

      final PayerPasswordLoginOutcome outcome = await h.api.loginWithPassword(
        identifier: 'owner@acme.in',
        password: 'Temp9xQ2',
        newPassword: 'MyOwnPass1',
      );

      final http.Request req = h.seen.single;
      expect(req.url.path, '/payer/login/password');
      expect(jsonDecode(req.body), <String, dynamic>{
        'identifier': 'owner@acme.in',
        'password': 'Temp9xQ2',
        'new_password': 'MyOwnPass1',
      });
      expect(req.headers.containsKey('authorization'), isFalse);
      final PayerLoginResult session = (outcome as PayerPasswordSignedIn).session;
      expect(session.accessToken, 'tok-new');
      expect(session.payerRole, PayerRole.agency);
      // The API layer never persists; the screen stores the session.
      expect(h.tokens.hasSession, isFalse);
    });

    test('a plain sign-in never sends new_password', () async {
      final h = _harness(
          (_) => json(<String, dynamic>{'access_token': 't', 'payer_id': 'p'}));
      await h.api.loginWithPassword(identifier: 'a@b.com', password: 'Secret1');
      final Map<String, dynamic> body =
          jsonDecode(h.seen.single.body) as Map<String, dynamic>;
      expect(body.containsKey('new_password'), isFalse);
    });

    test('a policy 400 on new_password carries the server reason', () async {
      final h = _harness((_) => json(<String, dynamic>{
            'statusCode': 400,
            'error': <String, dynamic>{
              'message': 'Validation failed',
              'issues': <Map<String, dynamic>>[
                <String, dynamic>{
                  'path': 'new_password',
                  'message': 'Password must be at least 8 characters',
                },
              ],
            },
          }, 400));

      await expectLater(
        h.api.loginWithPassword(
          identifier: 'owner@acme.in',
          password: 'Temp9xQ2',
          newPassword: 'short1',
        ),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'status', 400)
            .having((PayerApiException e) => e.validationMessage, 'reason',
                'Password must be at least 8 characters')),
      );
    });

    test('the same-as-temporary 400 carries its message', () async {
      final h = _harness((_) => json(<String, dynamic>{
            'statusCode': 400,
            'error': <String, dynamic>{
              'statusCode': 400,
              'message': 'Choose a new password - it cannot be the temporary one',
              'error': 'Bad Request',
            },
          }, 400));

      await expectLater(
        h.api.loginWithPassword(
          identifier: 'owner@acme.in',
          password: 'Temp9xQ2',
          newPassword: 'Temp9xQ2',
        ),
        throwsA(isA<PayerApiException>().having(
            (PayerApiException e) => e.validationMessage,
            'reason',
            'Choose a new password - it cannot be the temporary one')),
      );
    });

    test('a 400 that is not about new_password gives no reason', () async {
      final h = _harness((_) => json(<String, dynamic>{
            'error': <String, dynamic>{
              'message': 'Validation failed',
              'issues': <Map<String, dynamic>>[
                <String, dynamic>{'path': 'identifier', 'message': 'Required'},
              ],
            },
          }, 400));

      await expectLater(
        h.api.loginWithPassword(
          identifier: 'x',
          password: 'Temp9xQ2',
          newPassword: 'MyOwnPass1',
        ),
        throwsA(isA<PayerApiException>().having(
            (PayerApiException e) => e.validationMessage, 'reason', isNull)),
      );
    });

    test('a 400 on a plain sign-in keeps the bare mapping (no reason)',
        () async {
      final h = _harness((_) => json(<String, dynamic>{
            'error': <String, dynamic>{'message': 'Something about password'},
          }, 400));

      await expectLater(
        h.api.loginWithPassword(identifier: 'a@b.com', password: 'x'),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'status', 400)
            .having((PayerApiException e) => e.validationMessage, 'reason',
                isNull)),
      );
    });

    test('401 / 403 / 429 / 5xx keep their typed status on both legs',
        () async {
      for (final int status in <int>[401, 403, 429, 500, 503]) {
        for (final String? newPassword in <String?>[null, 'MyOwnPass1']) {
          final h = _harness((_) => json(<String, dynamic>{}, status));
          await expectLater(
            h.api.loginWithPassword(
              identifier: 'a@b.com',
              password: 'Temp9xQ2',
              newPassword: newPassword,
            ),
            throwsA(isA<PayerApiException>()
                .having((PayerApiException e) => e.statusCode, 'status', status)
                .having((PayerApiException e) => e.validationMessage, 'reason',
                    isNull)),
            reason: '$status / new=$newPassword',
          );
        }
      }
    });
  });

  group('#2597 — loginVerify refuses a temporary-password account', () {
    test('409 surfaces as a typed PayerPasswordChangeRequiredException',
        () async {
      final h = _harness((_) => http.Response(
            jsonEncode(<String, dynamic>{
              'statusCode': 409,
              'error': <String, dynamic>{
                'statusCode': 409,
                'message': 'Password change required',
                'error': 'Conflict',
              },
            }),
            409,
          ));

      await expectLater(
        h.api.loginVerify(email: 'owner@acme.in', code: '123456'),
        throwsA(isA<PayerPasswordChangeRequiredException>()
            .having((PayerApiException e) => e.statusCode, 'status', 409)),
      );
      expect(h.tokens.hasSession, isFalse);
    });

    test('a wrong code is still an empty-token verdict (unchanged)', () async {
      final h = _harness((_) => http.Response('{}', 401));
      final PayerLoginResult result =
          await h.api.loginVerify(email: 'a@b.com', code: '000000');
      expect(result.accessToken, isEmpty);
    });

    test('429 / 5xx still throw a plain PayerApiException', () async {
      for (final int status in <int>[429, 500]) {
        final h = _harness((_) => http.Response('{}', status));
        await expectLater(
          h.api.loginVerify(email: 'a@b.com', code: '000000'),
          throwsA(isA<PayerApiException>()
              .having((PayerApiException e) => e.statusCode, 'status', status)
              .having((PayerApiException e) => e is PayerPasswordChangeRequiredException,
                  'is change-required', isFalse)),
        );
      }
    });
  });

  group('#2597 — MockPayerAuthApi temporary password (opt-in)', () {
    test('the default mock never asks for a change (MOCK unchanged)', () async {
      final MockPayerAuthApi api = MockPayerAuthApi();
      await api.signup(role: 'employer', orgName: 'Acme', email: 'a@b.com');
      await api.setPassword(accessToken: 't', password: 'Secret123');

      expect(
        await api.loginWithPassword(identifier: 'a@b.com', password: 'Secret123'),
        isA<PayerPasswordSignedIn>(),
      );
      expect(await api.loginVerify(email: 'a@b.com', code: '1'),
          isA<PayerLoginResult>());
    });

    test('walks temporary → change required → new password → signed in',
        () async {
      final MockPayerAuthApi api = MockPayerAuthApi()
        ..issueTemporaryPassword(
          temporaryPassword: 'Temp9xQ2',
          role: 'agent',
          email: 'owner@acme.in',
        );

      expect(
        await api.loginWithPassword(
            identifier: 'owner@acme.in', password: 'Temp9xQ2'),
        isA<PayerPasswordChangeRequired>(),
      );
      // The code door is shut for this contact (409) …
      await expectLater(
        api.loginVerify(email: 'owner@acme.in', code: '123456'),
        throwsA(isA<PayerPasswordChangeRequiredException>()),
      );
      // … policy first (like the server's validation pipe), then same-as-temp.
      await expectLater(
        api.loginWithPassword(
            identifier: 'owner@acme.in', password: 'wrong', newPassword: 'abc'),
        throwsA(isA<PayerApiException>().having(
            (PayerApiException e) => e.validationMessage,
            'reason',
            'Password must be at least 8 characters')),
      );
      await expectLater(
        api.loginWithPassword(
          identifier: 'owner@acme.in',
          password: 'Temp9xQ2',
          newPassword: 'Temp9xQ2',
        ),
        throwsA(isA<PayerApiException>().having(
            (PayerApiException e) => e.validationMessage,
            'reason',
            'Choose a new password - it cannot be the temporary one')),
      );

      final PayerPasswordLoginOutcome changed = await api.loginWithPassword(
        identifier: 'owner@acme.in',
        password: 'Temp9xQ2',
        newPassword: 'MyOwnPass1',
      );
      expect((changed as PayerPasswordSignedIn).session.payerRole,
          PayerRole.agency);

      // The temporary password is dead; the new one signs straight in, and
      // the code door opens again.
      await expectLater(
        api.loginWithPassword(identifier: 'owner@acme.in', password: 'Temp9xQ2'),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'status', 401)),
      );
      expect(
        await api.loginWithPassword(
            identifier: 'owner@acme.in', password: 'MyOwnPass1'),
        isA<PayerPasswordSignedIn>(),
      );
      expect(await api.loginVerify(email: 'owner@acme.in', code: '1'),
          isA<PayerLoginResult>());
    });

    test('a different contact still gets a code session', () async {
      final MockPayerAuthApi api = MockPayerAuthApi()
        ..issueTemporaryPassword(
            temporaryPassword: 'Temp9xQ2', email: 'owner@acme.in');
      expect(await api.loginVerify(email: 'other@acme.in', code: '1'),
          isA<PayerLoginResult>());
    });
  });
}

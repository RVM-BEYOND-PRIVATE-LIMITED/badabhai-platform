import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_auth_api.dart';
import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/payer_account_api.dart';
import 'package:payer_app/core/session/app_session.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(
      jsonEncode(body),
      status,
      headers: <String, String>{'content-type': 'application/json'},
    );

void main() {
  // ---- C1: sign-out revokes server + wipes the bearer -----------------------
  group('C1 — AppSessionCubit.signOut', () {
    test('calls logout, clears the token store, and emits null', () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 't', payerId: 'p', role: 'employer');
      final _SpyAuthApi auth = _SpyAuthApi();
      final AppSessionCubit cubit =
          AppSessionCubit(authApi: auth, tokenStore: tokens);
      cubit.signIn(PayerRole.company);
      expect(cubit.state, isNotNull);

      await cubit.signOut();

      expect(auth.logoutCalls, 1); // best-effort server revoke fired
      expect(tokens.hasSession, isFalse); // bearer wiped from secure storage
      expect(cubit.state, isNull); // back to Login
    });

    test('still wipes the token + signs out when logout throws (offline)',
        () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 't', payerId: 'p', role: 'employer');
      final _SpyAuthApi auth = _SpyAuthApi(throwOnLogout: true);
      final AppSessionCubit cubit =
          AppSessionCubit(authApi: auth, tokenStore: tokens);
      cubit.signIn(PayerRole.company);

      await cubit.signOut(); // must NOT throw

      expect(auth.logoutCalls, 1);
      expect(tokens.hasSession, isFalse); // guaranteed local wipe
      expect(cubit.state, isNull);
    });
  });

  // ---- C2: a 401 refreshes + retries once, only reauth on refresh failure ---
  group('C2 — PayerHttp 401 → refresh → retry', () {
    test('refreshes once, persists the new bearer, retries with it', () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 'old-tok', payerId: 'p', role: 'employer');

      final List<http.Request> seen = <http.Request>[];
      final MockClient client = MockClient((http.Request req) async {
        seen.add(req);
        if (req.url.path == '/payer/refresh') {
          return _json(<String, dynamic>{
            'access_token': 'new-tok',
            'token_type': 'Bearer',
            'expires_in_seconds': 3600,
          });
        }
        // First hit to /payer/me is 401; the retry (new bearer) succeeds.
        final bool firstHit = seen
                .where((http.Request r) => r.url.path == '/payer/me')
                .length ==
            1;
        return firstHit
            ? http.Response('', 401)
            : _json(<String, dynamic>{'id': 'p', 'orgName': 'Acme'});
      });

      bool reauthed = false;
      late final PayerHttp payerHttp;
      payerHttp = PayerHttp(
        baseUrl: 'http://api.test',
        tokenStore: tokens,
        client: client,
        onReauth: () => reauthed = true,
        refreshToken: () async {
          final PayerResponse r =
              await payerHttp.send(PayerMethod.post, '/payer/refresh');
          return r.body['access_token'] as String?;
        },
      );

      final PayerResponse res = await payerHttp.send(PayerMethod.get, '/payer/me');

      // Retried request succeeded on the fresh bearer.
      expect(res.statusCode, 200);
      expect(res.body['orgName'], 'Acme');
      expect(reauthed, isFalse); // no force-logout on a recoverable 401
      expect(tokens.accessToken, 'new-tok'); // rotated bearer persisted

      final List<String> paths =
          seen.map((http.Request r) => r.url.path).toList();
      expect(paths, <String>['/payer/me', '/payer/refresh', '/payer/me']);
      // The refresh used the OLD bearer; the retry used the NEW one.
      expect(seen[1].headers['authorization'], 'Bearer old-tok');
      expect(seen[2].headers['authorization'], 'Bearer new-tok');
    });

    test('clears the session + fires reauth when the refresh itself fails',
        () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 'old-tok', payerId: 'p', role: 'employer');

      final MockClient client = MockClient((http.Request req) async {
        // /payer/me 401s; the refresh also 401s → terminal.
        return http.Response('', 401);
      });

      bool reauthed = false;
      late final PayerHttp payerHttp;
      payerHttp = PayerHttp(
        baseUrl: 'http://api.test',
        tokenStore: tokens,
        client: client,
        onReauth: () => reauthed = true,
        refreshToken: () async {
          final PayerResponse r =
              await payerHttp.send(PayerMethod.post, '/payer/refresh');
          return r.isSuccess ? r.body['access_token'] as String? : null;
        },
      );

      final PayerResponse res = await payerHttp.send(PayerMethod.get, '/payer/me');

      expect(res.statusCode, 401); // original 401 surfaced
      expect(reauthed, isTrue); // bounced to Login
      expect(tokens.hasSession, isFalse); // token wiped
    });
  });

  // ---- C3: /payer/me fetch + patch, phoneLast4 only -------------------------
  group('C3 — HttpPayerAccountApi', () {
    ({HttpPayerAccountApi api, List<http.Request> seen}) harness(
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
      final PayerHttp payerHttp = PayerHttp(
        baseUrl: 'http://api.test',
        tokenStore: tokens,
        client: client,
      );
      return (api: HttpPayerAccountApi(payerHttp), seen: seen);
    }

    test('fetchMe → GET /payer/me with bearer, parses phoneLast4 only',
        () async {
      final h = harness(
        (_) => _json(<String, dynamic>{
          'id': 'payer-9',
          'role': 'agent',
          'status': 'active',
          'orgName': 'Apex Staffing',
          'email': 'ops@apex.in',
          'phoneLast4': '3210',
        }),
      );

      final PayerMe me = await h.api.fetchMe();

      final http.Request req = h.seen.single;
      expect(req.method, 'GET');
      expect(req.url.path, '/payer/me');
      expect(req.headers['authorization'], 'Bearer tok-abc');
      expect(me.orgName, 'Apex Staffing');
      expect(me.email, 'ops@apex.in');
      expect(me.role, 'agent');
      expect(me.status, 'active');
      expect(me.phoneLast4, '3210'); // masked last-4 only — no full phone field
    });

    test('updateMe PATCHes ONLY changed fields, no body payer_id', () async {
      final h = harness(
        (_) => _json(<String, dynamic>{
          'id': 'payer-9',
          'role': 'employer',
          'status': 'active',
          'orgName': 'New Name',
          'email': 'a@b.com',
          'phoneLast4': '9988',
        }),
      );

      await h.api.updateMe(orgName: 'New Name');

      final http.Request req = h.seen.single;
      expect(req.method, 'PATCH');
      expect(req.url.path, '/payer/me');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body, <String, dynamic>{'orgName': 'New Name'}); // phone omitted
      expect(body.containsKey('payer_id'), isFalse);
    });

    test('updateMe sends phone (E164) when supplied; response is masked',
        () async {
      final h = harness(
        (_) => _json(<String, dynamic>{
          'id': 'payer-9',
          'role': 'employer',
          'status': 'active',
          'orgName': 'Acme',
          'email': 'a@b.com',
          'phoneLast4': '4321',
        }),
      );

      final PayerMe me = await h.api.updateMe(phone: '+919876554321');

      final Map<String, dynamic> body =
          jsonDecode(h.seen.single.body) as Map<String, dynamic>;
      expect(body, <String, dynamic>{'phone': '+919876554321'});
      // The response only ever carries the masked last-4.
      expect(me.phoneLast4, '4321');
    });
  });

  // ---- C3: mock account api keeps MOCK mode walkable ------------------------
  group('C3 — MockPayerAccountApi', () {
    test('role-aware canned identity, updateMe keeps only masked last-4',
        () async {
      final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
      await tokens.save(accessToken: 't', payerId: 'p', role: 'agent');
      final MockPayerAccountApi api = MockPayerAccountApi(tokens);

      final PayerMe me = await api.fetchMe();
      expect(me.role, 'agent');
      expect(me.orgName, 'Apex Staffing');
      expect(me.phoneLast4.length, 4);

      final PayerMe updated = await api.updateMe(phone: '+919000012345');
      expect(updated.phoneLast4, '2345'); // only the last-4 is retained
    });
  });
}

/// Records logout calls; can simulate an offline logout by throwing.
class _SpyAuthApi implements PayerAuthApi {
  _SpyAuthApi({this.throwOnLogout = false});

  final bool throwOnLogout;
  int logoutCalls = 0;

  @override
  Future<void> logout() async {
    logoutCalls++;
    if (throwOnLogout) throw Exception('offline');
  }

  @override
  Future<String?> refresh() async => null;

  @override
  Future<PayerLoginResult> loginVerify({
    required String email,
    required String code,
  }) async =>
      throw UnimplementedError();

  @override
  Future<void> loginRequest({required String email}) async {}

  @override
  Future<void> signup({
    required String role,
    required String email,
    required String orgName,
  }) async {}
}

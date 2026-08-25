import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';

/// The account-deleted contract on the payer HTTP seam: a call made with a VALID
/// bearer whose payer row is gone comes back 410 { code: PAYER_ACCOUNT_DELETED }.
/// [PayerHttp] must fire `onAccountDeleted` on that (real nested + flat shapes),
/// STILL return the 410 to the caller, and NEVER route it through the 401
/// refresh dance. A normal 401 must keep refreshing exactly as before, and it
/// must never fire the account-deleted callback.
http.Response _json(Map<String, dynamic> body, int status) =>
    http.Response(jsonEncode(body), status,
        headers: <String, String>{'content-type': 'application/json'});

({
  PayerHttp http,
  PayerTokenStore tokens,
  int Function() refreshCalls,
  int Function() reauthCalls,
  int Function() deletedCalls,
}) _harness(
  MockClient client, {
  Future<String?> Function()? refreshToken,
}) {
  int refresh = 0;
  int reauth = 0;
  int deleted = 0;
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // Seed a bearer so the calls are authed.
  // ignore: discarded_futures
  tokens.save(accessToken: 'jwt', payerId: 'p', role: 'employer');
  final PayerHttp client0 = PayerHttp(
    baseUrl: 'http://api.test',
    tokenStore: tokens,
    client: client,
    onReauth: () => reauth++,
    onAccountDeleted: () => deleted++,
    refreshToken: refreshToken == null
        ? null
        : () {
            refresh++;
            return refreshToken();
          },
  );
  return (
    http: client0,
    tokens: tokens,
    refreshCalls: () => refresh,
    reauthCalls: () => reauth,
    deletedCalls: () => deleted,
  );
}

void main() {
  group('PayerHttp PAYER_ACCOUNT_DELETED (410) detection', () {
    test('REAL envelope: 410 + { error: { code } } fires ONCE, no refresh, still '
        'returns 410', () async {
      final h = _harness(
        MockClient((http.Request _) async => _json(<String, dynamic>{
              'statusCode': 410,
              'error': <String, dynamic>{
                'code': 'PAYER_ACCOUNT_DELETED',
                'message': 'This account no longer exists.',
              },
            }, 410)),
        // A refresh function IS wired — the point is that a 410 must NOT use it.
        refreshToken: () async => 'tok-fresh',
      );

      final PayerResponse res =
          await h.http.send(PayerMethod.get, '/payer/credits');

      expect(res.statusCode, 410, reason: 'the caller still sees the 410');
      expect(h.deletedCalls(), 1, reason: 'exactly one hard-logout signal');
      expect(h.refreshCalls(), 0,
          reason: 'a 410 must never enter the 401 refresh dance');
      expect(h.reauthCalls(), 0, reason: 'not the recoverable reauth path');
    });

    test('also fires on a TOP-LEVEL { code } 410 (flatter shape)', () async {
      final h = _harness(
        MockClient((http.Request _) async => _json(
            <String, dynamic>{'code': 'PAYER_ACCOUNT_DELETED'}, 410)),
      );

      final PayerResponse res =
          await h.http.send(PayerMethod.get, '/payer/credits');

      expect(res.statusCode, 410);
      expect(h.deletedCalls(), 1);
    });

    test('a 410 WITHOUT the code does NOT fire', () async {
      final h = _harness(
        MockClient((http.Request _) async =>
            _json(<String, dynamic>{'error': <String, dynamic>{}}, 410)),
      );

      final PayerResponse res =
          await h.http.send(PayerMethod.get, '/payer/credits');

      expect(res.statusCode, 410);
      expect(h.deletedCalls(), 0, reason: 'a bare 410 must never force a logout');
    });

    test('a 410 with a DIFFERENT code does NOT fire', () async {
      final h = _harness(
        MockClient((http.Request _) async =>
            _json(<String, dynamic>{'code': 'RESOURCE_GONE'}, 410)),
      );

      await h.http.send(PayerMethod.get, '/payer/credits');

      expect(h.deletedCalls(), 0,
          reason: '410 is reserved for PAYER_ACCOUNT_DELETED only');
    });
  });

  group('the 401 refresh dance is UNCHANGED (regression guard)', () {
    test('a normal 401 refreshes + retries once and does NOT fire the '
        'account-deleted callback', () async {
      int calls = 0;
      final h = _harness(
        MockClient((http.Request _) async {
          calls++;
          // First attempt 401, post-refresh retry succeeds.
          return calls == 1
              ? http.Response('', 401)
              : _json(<String, dynamic>{'ok': true}, 200);
        }),
        refreshToken: () async => 'tok-fresh',
      );

      final PayerResponse res =
          await h.http.send(PayerMethod.get, '/payer/credits');

      expect(res.statusCode, 200, reason: 'the retry after refresh succeeds');
      expect(h.refreshCalls(), 1, reason: 'the 401 still triggers one refresh');
      expect(calls, 2, reason: 'original 401 + one retry');
      expect(h.deletedCalls(), 0,
          reason: 'a 401 is recoverable — never account deletion');
    });

    test('a 401 whose refresh FAILS clears the bearer + fires onReauth (not '
        'onAccountDeleted)', () async {
      final h = _harness(
        MockClient((http.Request _) async => http.Response('', 401)),
        refreshToken: () async => null, // refresh unavailable → force reauth
      );

      final PayerResponse res =
          await h.http.send(PayerMethod.get, '/payer/credits');

      expect(res.statusCode, 401);
      expect(h.reauthCalls(), 1, reason: 'unchanged force-reauth behavior');
      expect(h.tokens.hasSession, isFalse, reason: 'the bearer is wiped');
      expect(h.deletedCalls(), 0);
    });

    test('a 401 CARRYING the deleted code still does NOT fire it (status must be '
        'exactly 410)', () async {
      final h = _harness(
        MockClient((http.Request _) async => _json(<String, dynamic>{
              'error': <String, dynamic>{'code': 'PAYER_ACCOUNT_DELETED'},
            }, 401)),
        refreshToken: () async => null,
      );

      await h.http.send(PayerMethod.get, '/payer/credits');

      expect(h.deletedCalls(), 0,
          reason: 'the reserved trigger requires status == 410');
      expect(h.reauthCalls(), 1, reason: 'a 401 stays on the reauth path');
    });
  });
}

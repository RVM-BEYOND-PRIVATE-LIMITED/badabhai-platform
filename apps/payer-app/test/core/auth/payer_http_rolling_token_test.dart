import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';

/// ADR-0035 fast-follow — `PayerHttp` ignored the ROLLING session token.
///
/// `PayerAuthGuard` re-mints the payer's JWT once the current one is past its
/// half-life and returns it in the `x-session-token` response header
/// (`apps/api/src/payers/payer-auth.guard.ts`). The payer app never read that
/// header: it only recovered REACTIVELY, after a request had already come back
/// 401. For a long-lived screen — the AI job-posting chat, which can sit open
/// past the half-life mid-draft — that meant eating a failed turn, and a bounce
/// to Login if the reactive refresh itself failed, for a session the server had
/// already offered to renew.
///
/// These tests fail against the old client: nothing was persisted, so the second
/// request still carried the stale bearer.
class _Recorder {
  final List<http.Request> seen = <http.Request>[];

  /// Serves [responses] in order, falling back to the last one.
  http.Client client(List<http.Response> responses) {
    int i = 0;
    return MockClient((http.Request req) async {
      seen.add(req);
      final http.Response res =
          responses[i < responses.length ? i : responses.length - 1];
      i++;
      return res;
    });
  }
}

http.Response _ok({String? rolling}) => http.Response(
      '{}',
      200,
      headers: <String, String>{
        'content-type': 'application/json',
        if (rolling != null) 'x-session-token': rolling,
      },
    );

({PayerHttp http, PayerTokenStore tokens, _Recorder rec}) _harness(
  List<http.Response> responses, {
  String bearer = 'stale.jwt',
}) {
  final _Recorder rec = _Recorder();
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // ignore: discarded_futures
  tokens.save(accessToken: bearer, payerId: 'p', role: 'employer');
  return (
    http: PayerHttp(
      baseUrl: 'http://api.test',
      tokenStore: tokens,
      client: rec.client(responses),
    ),
    tokens: tokens,
    rec: rec,
  );
}

void main() {
  group('PayerHttp — rolling x-session-token', () {
    test('persists the refreshed token and signs the NEXT request with it',
        () async {
      final h = _harness(<http.Response>[
        _ok(rolling: 'fresh.jwt'),
        _ok(),
      ]);

      await h.http.send(PayerMethod.get, '/payer/credits');
      expect(h.tokens.accessToken, 'fresh.jwt',
          reason: 'the rolling token must reach secure storage');

      await h.http.send(PayerMethod.get, '/payer/capacity');
      expect(h.rec.seen.last.headers['authorization'], 'Bearer fresh.jwt');
    });

    test('adopts it on a NON-2xx too — the session is still being renewed',
        () async {
      // A 500 that carries a rolling token is still a valid renewal; dropping it
      // would leave the next retry signing with the stale bearer.
      final h = _harness(<http.Response>[
        http.Response('{}', 500, headers: <String, String>{
          'x-session-token': 'fresh.jwt',
        }),
      ]);

      final PayerResponse res = await h.http.send(PayerMethod.get, '/payer/credits');

      expect(res.statusCode, 500);
      expect(h.tokens.accessToken, 'fresh.jwt');
    });

    test('no header / empty header / unchanged value → the store is untouched',
        () async {
      for (final http.Response res in <http.Response>[
        _ok(),
        http.Response('{}', 200,
            headers: <String, String>{'x-session-token': ''}),
        _ok(rolling: 'stale.jwt'),
      ]) {
        final h = _harness(<http.Response>[res]);
        await h.http.send(PayerMethod.get, '/payer/credits');
        expect(h.tokens.accessToken, 'stale.jwt');
      }
    });

    test('an UNAUTHED call never adopts one', () async {
      final h = _harness(<http.Response>[_ok(rolling: 'fresh.jwt')]);

      await h.http.send(PayerMethod.post, '/payer/request-otp', authed: false);

      expect(h.tokens.accessToken, 'stale.jwt');
    });

    test('/payer/refresh and /payer/logout never adopt one', () async {
      // The refresh response's own BODY token is what `send` persists, and
      // adopting a token on the way out of logout would re-seed a session that
      // is being killed.
      for (final String path in <String>['/payer/refresh', '/payer/logout']) {
        final h = _harness(<http.Response>[_ok(rolling: 'fresh.jwt')]);
        await h.http.send(PayerMethod.post, path);
        expect(h.tokens.accessToken, 'stale.jwt', reason: path);
      }
    });

    test('a long session never has to fall through a 401 to stay alive',
        () async {
      // The regression in one shot: ten authed calls, each renewing. Without the
      // fix every call after the first would still carry `stale.jwt`.
      final h = _harness(<http.Response>[_ok(rolling: 'rolled.jwt'), _ok()]);

      for (int i = 0; i < 10; i++) {
        await h.http.send(PayerMethod.post, '/payer/job-posting-chat/message',
            body: <String, dynamic>{'session_id': 's', 'text': 'hi'});
      }

      expect(h.tokens.accessToken, 'rolled.jwt');
      expect(
        h.rec.seen.skip(1).every(
            (http.Request r) => r.headers['authorization'] == 'Bearer rolled.jwt'),
        isTrue,
      );
    });
  });
}

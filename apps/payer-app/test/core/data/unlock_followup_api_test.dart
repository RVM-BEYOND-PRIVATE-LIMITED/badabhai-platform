import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/data/unlock_followup_models.dart';

class _Router {
  _Router(this.routes);
  final Map<String, http.Response> routes;
  final List<http.Request> seen = <http.Request>[];

  http.Client client() => MockClient((http.Request req) async {
        seen.add(req);
        return routes['${req.method} ${req.url.path}'] ??
            http.Response('{}', 404);
      });
}

({HttpPayerApiClient api, _Router router}) _harness(
  Map<String, http.Response> routes,
) {
  final _Router router = _Router(routes);
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // ignore: discarded_futures
  tokens.save(accessToken: 'tok-abc', payerId: 'p', role: 'employer');
  final PayerHttp httpClient = PayerHttp(
    baseUrl: 'http://api.test',
    tokenStore: tokens,
    client: router.client(),
  );
  return (api: HttpPayerApiClient(httpClient), router: router);
}

http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status,
        headers: <String, String>{'content-type': 'application/json'});

Map<String, dynamic> _resultBody({
  String unlockId = 'u-1',
  String workerId = 'w-1',
  String outcome = 'hired',
}) =>
    <String, dynamic>{
      'unlock_id': unlockId,
      'worker_id': workerId,
      'outcome': outcome,
      'previous_outcome': null,
      'answered_at': '2026-11-20T10:00:00Z',
      'changed': true,
    };

void main() {
  group('fetchDueUnlockOutcomes', () {
    test('GETs the due path with limit + cursor and parses the page', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/unlock-outcomes/due': _json(<String, dynamic>{
          'items': <dynamic>[
            <String, dynamic>{
              'unlock_id': 'u-1',
              'worker_id': 'w-1',
              'granted_at': '2026-11-01T10:00:00Z',
              'outcome': null,
            },
          ],
          'nextCursor': 'c-2',
        }),
      });

      final UnlockFollowupPage? page =
          await h.api.fetchDueUnlockOutcomes(limit: 5, cursor: 'c-1');

      expect(page, isNotNull);
      expect(page!.items.single.unlockId, 'u-1');
      expect(page.nextCursor, 'c-2');
      final http.Request req = h.router.seen.single;
      expect(req.method, 'GET');
      expect(req.url.path, '/payer/unlock-outcomes/due');
      expect(req.url.queryParameters['limit'], '5');
      expect(req.url.queryParameters['cursor'], 'c-1');
      expect(req.headers['authorization'], 'Bearer tok-abc');
    });

    test('404 is the switch off → null, not an error', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/unlock-outcomes/due':
            _json(<String, dynamic>{'message': 'off'}, 404),
      });

      expect(await h.api.fetchDueUnlockOutcomes(), isNull);
    });

    test('a non-404 failure throws with its status', () async {
      for (final int status in <int>[429, 500]) {
        final h = _harness(<String, http.Response>{
          'GET /payer/unlock-outcomes/due':
              _json(<String, dynamic>{'message': 'nope'}, status),
        });
        await expectLater(
          h.api.fetchDueUnlockOutcomes(),
          throwsA(isA<PayerApiException>()
              .having((PayerApiException e) => e.statusCode, 'status', status)),
        );
      }
    });

    test('a malformed 2xx throws — never an empty due list', () async {
      final List<http.Response> bad = <http.Response>[
        http.Response('<html>Sign in to WiFi</html>', 200),
        _json(<String, dynamic>{'items': 'nope'}),
        _json(<String, dynamic>{
          'items': <dynamic>[
            <String, dynamic>{
              'unlock_id': 'u-1',
              'worker_id': 'w-1',
              'granted_at': '2026-11-01T10:00:00Z',
              'outcome': 'maybe',
            },
          ],
        }),
      ];
      for (final http.Response body in bad) {
        final h = _harness(<String, http.Response>{
          'GET /payer/unlock-outcomes/due': body,
        });
        await expectLater(
          h.api.fetchDueUnlockOutcomes(),
          throwsA(isA<PayerApiException>()),
        );
      }
    });
  });

  group('recordUnlockOutcome', () {
    test('POSTs the outcome body with its idempotency-key header', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/unlocks/u-1/outcome': _json(_resultBody()),
      });

      final UnlockFollowupResult result = await h.api.recordUnlockOutcome(
        unlockId: 'u-1',
        outcome: UnlockFollowupOutcome.hired,
        idempotencyKey: 'idem-123',
      );

      expect(result.outcome, UnlockFollowupOutcome.hired);
      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/unlocks/u-1/outcome');
      expect(jsonDecode(req.body), <String, dynamic>{'outcome': 'hired'});
      expect(req.headers['idempotency-key'], 'idem-123');
      expect(req.headers['authorization'], 'Bearer tok-abc');
    });

    test('a neutral 404 and the 429 cap throw with their status', () async {
      for (final int status in <int>[404, 429]) {
        final h = _harness(<String, http.Response>{
          'POST /payer/unlocks/u-1/outcome':
              _json(<String, dynamic>{'message': 'no'}, status),
        });
        await expectLater(
          h.api.recordUnlockOutcome(
            unlockId: 'u-1',
            outcome: UnlockFollowupOutcome.notHired,
            idempotencyKey: 'idem-123',
          ),
          throwsA(isA<PayerApiException>()
              .having((PayerApiException e) => e.statusCode, 'status', status)),
        );
      }
    });
  });
}

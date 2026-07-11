import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/features/earn/presentation/cubit/referral_cubit.dart';

/// The invite link is minted by a WRITE (`POST /payer/agency/invites`) that
/// creates a new code + emits `agency_invite.created` EVERY call. The hub is a
/// factory cubit (fresh instance + load() per open), so the link is cached for
/// the SESSION: re-opening the hub must reuse the same code, not churn invites.
class _Router {
  _Router(this.routes);
  final Map<String, http.Response> routes;
  final List<http.Request> seen = <http.Request>[];

  http.Client client() => MockClient((http.Request req) async {
        seen.add(req);
        final String key = '${req.method} ${req.url.path}';
        return routes[key] ?? http.Response('{}', 404);
      });
}

({HttpPayerApiClient api, _Router router}) _harness(
  Map<String, http.Response> routes,
) {
  final _Router router = _Router(routes);
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // ignore: discarded_futures
  tokens.save(accessToken: 'tok-abc', payerId: 'p', role: 'agent');
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

int _mintCount(_Router r) => r.seen
    .where((http.Request req) => req.url.path == '/payer/agency/invites')
    .length;

void main() {
  setUp(ReferralCubit.resetSessionLink);
  tearDown(ReferralCubit.resetSessionLink);

  group('ReferralCubit — link minted once per session', () {
    test('two hub opens (two cubit instances) mint the invite ONLY once',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/invites': _json(<String, dynamic>{
          'agency_invite_id': 'inv-1',
          'code': 'APEX-7K2',
          'link': '/i/APEX-7K2',
        }),
        'GET /payer/agency/referrals/summary': _json(<String, dynamic>{
          'created': 10,
          'clicked': 6,
          'accepted': 3,
          'minBucket': 5,
        }),
      });

      final ReferralCubit first = ReferralCubit(h.api);
      await first.load();
      final ReferralCubit second = ReferralCubit(h.api);
      await second.load();

      // The POST that mints a code ran exactly ONCE across both opens…
      expect(_mintCount(h.router), 1);
      // …and both cubits show the SAME stable code.
      expect(first.state.link?.code, 'APEX-7K2');
      expect(second.state.link?.code, 'APEX-7K2');
      expect(second.state.status, ReferralLoadStatus.ready);
    });

    test('refreshLink() mints a fresh code on purpose', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/invites': _json(<String, dynamic>{
          'agency_invite_id': 'inv-1',
          'code': 'APEX-7K2',
          'link': '/i/APEX-7K2',
        }),
      });

      final ReferralCubit c = ReferralCubit(h.api);
      await c.load();
      await c.refreshLink();

      // Two mints: the initial load + the explicit refresh.
      expect(_mintCount(h.router), 2);
    });

    test('recordClick → POST /payer/agency/invites/:code/click for the code',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/invites': _json(<String, dynamic>{
          'agency_invite_id': 'inv-1',
          'code': 'APEX-7K2',
          'link': '/i/APEX-7K2',
        }),
        'POST /payer/agency/invites/APEX-7K2/click':
            _json(<String, dynamic>{'ok': true}),
      });
      final ReferralCubit cubit = ReferralCubit(h.api);
      await cubit.load();
      await cubit.recordClick();

      expect(
        h.router.seen.any((http.Request r) =>
            r.url.path == '/payer/agency/invites/APEX-7K2/click'),
        isTrue,
      );
    });

    test('recordClick with no loaded link is a no-op (no request)', () async {
      final h = _harness(<String, http.Response>{});
      await ReferralCubit(h.api).recordClick();
      expect(h.router.seen, isEmpty);
    });
  });
}

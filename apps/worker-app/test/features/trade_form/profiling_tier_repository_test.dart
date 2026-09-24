import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/data/trade_form_repository_impl.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/profiling_tier.dart';

/// #1698 — the REQUESTS the tier feature makes, asserted on the wire.
///
/// The repository tests here drive the real [ApiClient] over a [MockClient], so
/// the path, the query string, the bearer and the body are the ones the app
/// would really send — not a double's idea of them.
SessionRepository _session({String? token = 'tok'}) {
  final SessionRepository s = SessionRepository();
  if (token != null) {
    s.setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: token);
  }
  return s;
}

TradeFormRepositoryImpl _repo(MockClient client, {String? token = 'tok'}) =>
    TradeFormRepositoryImpl(
      ApiClient(baseUrl: 'http://test', client: client),
      _session(token: token),
    );

String _tiersBody({
  bool enabled = true,
  bool needsChoice = true,
  String? currentTier,
  List<String> upgradableTo = const <String>[],
}) => jsonEncode(<String, dynamic>{
  'enabled': enabled,
  'kind': 'cnc_turner',
  'needs_choice': needsChoice,
  'current_tier': currentTier,
  'upgradable_to': upgradableTo,
  'tiers': <Map<String, dynamic>>[
    <String, dynamic>{
      'tier': 'easy',
      'min_minutes': 2,
      'max_minutes': 3,
      'question_count': 6,
    },
  ],
});

void main() {
  group('GET /profiling/form/tiers', () {
    test('hits the route with the bearer and parses the state', () async {
      late http.Request captured;
      final TradeFormRepositoryImpl repo = _repo(
        MockClient((http.Request req) async {
          captured = req;
          return http.Response(_tiersBody(), 200);
        }),
      );

      final TierState state = await repo.loadTierState();

      expect(captured.method, 'GET');
      expect(captured.url.path, '/profiling/form/tiers');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(state.enabled, isTrue);
      expect(state.shouldChooseTier, isTrue);
    });

    test('NEVER throws — a 404, a 401, a 500 and a garbage body all read as '
        'disabled', () async {
      for (final int status in <int>[404, 401, 403, 500]) {
        final TradeFormRepositoryImpl repo = _repo(
          MockClient((http.Request req) async => http.Response('{}', status)),
        );
        expect(await repo.loadTierState(), TierState.disabled,
            reason: 'status $status must not stop the worker');
      }
      final TradeFormRepositoryImpl garbage = _repo(
        MockClient((http.Request req) async => http.Response('not json', 200)),
      );
      expect(await garbage.loadTierState(), TierState.disabled);
    });

    test('no session: disabled, and no request is made at all', () async {
      final TradeFormRepositoryImpl repo = _repo(
        MockClient((http.Request req) async => fail('must not be hit')),
        token: null,
      );
      expect(await repo.loadTierState(), TierState.disabled);
    });
  });

  group('POST /profiling/form/tier', () {
    test('sends the wire token and parses the change', () async {
      late http.Request captured;
      final TradeFormRepositoryImpl repo = _repo(
        MockClient((http.Request req) async {
          captured = req;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'tier': 'hard',
              'previous_tier': 'easy',
              'change': 'upgraded',
            }),
            200,
          );
        }),
      );

      final TierChoice? choice = await repo.chooseTier(ProfilingTier.hard);

      expect(captured.method, 'POST');
      expect(captured.url.path, '/profiling/form/tier');
      expect(
        jsonDecode(captured.body),
        <String, dynamic>{'tier': 'hard'},
        reason: 'the wire token, never the Dart enum name',
      );
      expect(choice!.change, TierChange.upgraded);
      expect(choice.needsUpgradeView, isTrue);
    });

    test('a 409 (a downgrade this app should never have offered) surfaces the '
        "server's own sentence", () async {
      final TradeFormRepositoryImpl repo = _repo(
        MockClient(
          (http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{'message': 'Tier cannot be lowered'}),
            409,
          ),
        ),
      );

      await expectLater(
        repo.chooseTier(ProfilingTier.easy),
        throwsA(
          isA<InvalidRequestFailure>().having(
            (InvalidRequestFailure f) => f.message,
            'message',
            'Tier cannot be lowered',
          ),
        ),
      );
    });

    test('UNLIKE the read, a transport failure PROPAGATES — a silent failure '
        'would open the form at a tier the worker did not pick', () async {
      final TradeFormRepositoryImpl repo = _repo(
        MockClient((http.Request req) async => http.Response('{}', 500)),
      );
      await expectLater(
        repo.chooseTier(ProfilingTier.medium),
        throwsA(isA<Failure>()),
      );
    });
  });

  group('GET /profiling/form?view=…', () {
    test('an ORDINARY load sends no view parameter at all — the request an '
        'older server has always seen', () async {
      late http.Request captured;
      final TradeFormRepositoryImpl repo = _repo(
        MockClient((http.Request req) async {
          captured = req;
          return http.Response('{}', 404);
        }),
      );

      await repo.loadForm();

      expect(captured.url.path, '/profiling/form');
      expect(captured.url.query, isEmpty);
    });

    test('an UPGRADE load asks for view=upgrade', () async {
      late http.Request captured;
      final TradeFormRepositoryImpl repo = _repo(
        MockClient((http.Request req) async {
          captured = req;
          return http.Response('{}', 404);
        }),
      );

      await repo.loadForm(upgradeView: true);

      expect(captured.url.path, '/profiling/form');
      expect(captured.url.queryParameters['view'], 'upgrade');
    });
  });

  group('mock mode parity', () {
    test('tiers are OFF by default, mirroring every real box today', () async {
      final MockApiClient api = MockApiClient();
      final TierState state = TierState.fromJson(
        await api.getProfilingTiers(authToken: 'mock'),
      );
      expect(state.enabled, isFalse);
      expect(state.shouldChooseTier, isFalse);
    });

    test('with tiers on it serves three priced tiers and only ever raises',
        () async {
      final MockApiClient api = MockApiClient()
        ..mockProfilingTiersEnabled = true;

      final TierState first = TierState.fromJson(
        await api.getProfilingTiers(authToken: 'mock'),
      );
      expect(first.needsChoice, isTrue);
      expect(first.tiers, hasLength(3));

      final TierChoice? selected = TierChoice.fromJson(
        await api.chooseProfilingTier(authToken: 'mock', tier: 'easy'),
      );
      expect(selected!.change, TierChange.selected);

      final TierChoice? upgraded = TierChoice.fromJson(
        await api.chooseProfilingTier(authToken: 'mock', tier: 'hard'),
      );
      expect(upgraded!.change, TierChange.upgraded);

      // And a downgrade is refused exactly as the server refuses it, rather
      // than quietly accepted here and hiding a client bug.
      await expectLater(
        api.chooseProfilingTier(authToken: 'mock', tier: 'easy'),
        throwsA(isA<ApiException>()),
      );
    });
  });
}

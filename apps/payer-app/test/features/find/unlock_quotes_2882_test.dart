import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/candidate_search_models.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/find/presentation/cubit/candidate_search_cubit.dart';

/// #2750/#2882 — the quote layer on the app: the wire contract, the honest refusal,
/// and the two lists' soft quote read (a quote failure never breaks the feed).
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
  return (
    api: HttpPayerApiClient(PayerHttp(
      baseUrl: 'http://api.test',
      tokenStore: tokens,
      client: router.client(),
    )),
    router: router,
  );
}

http.Response _json(Object body, [int status = 200]) => http.Response(
      jsonEncode(body),
      status,
      headers: <String, String>{'content-type': 'application/json'},
    );

const String _w1 = 'face2000-0000-4000-8000-000000000001';
const String _w2 = 'face2000-0000-4000-8000-000000000002';

CandidateSearchRow _row(String workerId) => CandidateSearchRow(
      workerId: workerId,
      matchesFilters: true,
      matchTier: null,
      role: const LabelledId(id: 'mskill_cnc_turner', label: 'CNC Turner'),
      otherRoles: const <LabelledId>[],
      skillMonths: 48,
      industry: const LabelledId(
        id: 'ind_industrial_manufacturing',
        label: 'Industrial Manufacturing',
      ),
      industryMonths: 54,
      city: 'Pune',
      tradeLevels: const <CandidateTradeLevel>[],
    );

class _QuoteApi extends MockPayerApiClient {
  UnlockQuotes? quotes;
  Object? quoteError;
  final List<List<String>> quoteReads = <List<String>>[];
  UnlockResult unlockResult = const UnlockResult.granted(unlockId: 'u-1');

  @override
  Future<CandidateSearchPage> searchCandidates(CandidateSearchQuery query) async =>
      CandidateSearchPage(
        total: 2,
        matched: 2,
        unrecorded: 0,
        filtered: false,
        strict: false,
        candidates: <CandidateSearchRow>[_row(_w1), _row(_w2)],
        nextCursor: null,
      );

  @override
  Future<List<PayerUnlock>> fetchOwnUnlocks() async => const <PayerUnlock>[];

  @override
  Future<CandidateFilters> fetchCandidateFilters() async =>
      const CandidateFilters(
        roles: <CandidateRoleOption>[],
        industries: <LabelledId>[],
        experienceBuckets: <LabelledId>[],
        cities: <String>[],
        maxRoles: 5,
      );

  @override
  Future<UnlockQuotes?> fetchUnlockQuotes(List<String> workerIds) async {
    quoteReads.add(workerIds);
    if (quoteError != null) throw quoteError!;
    return quotes;
  }

  @override
  Future<UnlockResult> unlock({required String workerId, String? jobId}) async =>
      unlockResult;
}

void main() {
  group('UnlockQuotes — the wire', () {
    test('parses worker → credits and the spendable balance', () {
      final UnlockQuotes? q = UnlockQuotes.tryFromJson(<String, dynamic>{
        'quotes': <Map<String, dynamic>>[
          <String, dynamic>{'worker_id': _w1, 'credits': 2},
          <String, dynamic>{'worker_id': _w2, 'credits': 0},
        ],
        'credits_available': 1,
      });
      expect(q, isNotNull);
      expect(q!.creditsFor(_w1), 2);
      expect(q.creditsFor(_w2), 0);
      expect(q.creditsAvailable, 1);
      expect(q.unaffordableFor(_w1), isTrue);
      expect(q.unaffordableFor(_w2), isFalse);
    });

    test('a malformed body is null, never a guessed price', () {
      expect(UnlockQuotes.tryFromJson(<String, dynamic>{}), isNull);
      expect(
        UnlockQuotes.tryFromJson(<String, dynamic>{
          'quotes': <dynamic>[
            <String, dynamic>{'worker_id': _w1, 'credits': 'two'},
          ],
          'credits_available': 1,
        }),
        isNull,
      );
    });

    test('afterUnlock folds a grant (0) and a refusal balance in', () {
      const UnlockQuotes q = UnlockQuotes(
        creditsByWorker: <String, int>{_w1: 2},
        creditsAvailable: 3,
      );
      final UnlockQuotes granted =
          q.afterUnlock(_w1, const UnlockResult.granted(unlockId: 'u', creditsCharged: 2));
      expect(granted.creditsFor(_w1), 0);
      expect(granted.creditsAvailable, 1);

      final UnlockQuotes refused = q.afterUnlock(
        _w1,
        const UnlockResult.insufficient(creditsNeeded: 2, creditsAvailable: 1),
      );
      expect(refused.creditsAvailable, 1);
      expect(refused.creditsFor(_w1), 2);
    });
  });

  group('HTTP /payer/unlocks/quotes', () {
    test('posts worker_ids only; 404 is null (today\'s button)', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/unlocks/quotes': _json(<String, dynamic>{
          'quotes': <Map<String, dynamic>>[
            <String, dynamic>{'worker_id': _w1, 'credits': 2},
          ],
          'credits_available': 4,
        }),
      });

      final UnlockQuotes? q = await h.api.fetchUnlockQuotes(<String>[_w1]);

      expect(q!.creditsFor(_w1), 2);
      final http.Request req = h.router.seen.single;
      expect(jsonDecode(req.body), <String, dynamic>{
        'worker_ids': <String>[_w1],
      });
      expect((jsonDecode(req.body) as Map<String, dynamic>).containsKey('payer_id'),
          isFalse);

      final h404 = _harness(<String, http.Response>{
        'POST /payer/unlocks/quotes': _json(<String, dynamic>{}, 404),
      });
      expect(await h404.api.fetchUnlockQuotes(<String>[_w1]), isNull);
    });

    test('unlock parses the honest refusal and credits_charged', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/unlocks': _json(<String, dynamic>{
          'status': 'insufficient_credits',
          'credits_needed': 2,
          'credits_available': 1,
        }),
      });
      final UnlockResult refused = await h.api.unlock(workerId: _w1);
      expect(refused.insufficient, isTrue);
      expect(refused.granted, isFalse);
      expect(refused.creditsNeeded, 2);
      expect(refused.creditsAvailable, 1);

      final h2 = _harness(<String, http.Response>{
        'POST /payer/unlocks': _json(<String, dynamic>{
          'ok': true,
          'unlock_id': 'u-9',
          'status': 'granted',
          'credits_charged': 2,
        }),
      });
      final UnlockResult granted = await h2.api.unlock(workerId: _w1);
      expect(granted.granted, isTrue);
      expect(granted.creditsCharged, 2);
    });
  });

  group('the lists read quotes softly', () {
    test('CandidateSearchCubit loads the page quote and folds an unlock in', () async {
      final _QuoteApi api = _QuoteApi()
        ..quotes = const UnlockQuotes(
          creditsByWorker: <String, int>{_w1: 2, _w2: 1},
          creditsAvailable: 1,
        )
        ..unlockResult = const UnlockResult.granted(unlockId: 'u', creditsCharged: 2);
      final CandidateSearchCubit cubit = CandidateSearchCubit(api);
      addTearDown(cubit.close);

      await cubit.load();

      expect(api.quoteReads.single, <String>[_w1, _w2]);
      expect(cubit.state.quotedCreditsFor(_w1), 2);
      expect(cubit.state.quoteUnaffordableFor(_w1), isTrue);
      expect(cubit.state.quoteUnaffordableFor(_w2), isFalse);

      await cubit.unlock(cubit.state.rows.first);

      expect(cubit.state.quotedCreditsFor(_w1), 0);
      expect(cubit.state.quotes!.creditsAvailable, 0);
    });

    test('a quote outage leaves the search page intact (today\'s button)', () async {
      final _QuoteApi api = _QuoteApi()..quoteError = Exception('offline');
      final CandidateSearchCubit cubit = CandidateSearchCubit(api);
      addTearDown(cubit.close);

      await cubit.load();

      expect(cubit.state.status, CandidateSearchStatus.ready);
      expect(cubit.state.rows, hasLength(2));
      expect(cubit.state.quotes, isNull);
    });
  });
}

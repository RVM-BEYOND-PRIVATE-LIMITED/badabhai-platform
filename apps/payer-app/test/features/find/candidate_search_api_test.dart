import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/candidate_search_models.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';

/// The all-candidates search over the REAL [HttpPayerApiClient], driven by a
/// routed [MockClient] (the backend is not running): the snake_case POST body,
/// the camelCase parse of the pinned fixture, and the error mapping the screen
/// depends on — a 429 / 400 / 5xx keeps its status, and NO failure (including
/// a 2xx that is not the contract) ever decodes to an empty pool.
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

final Map<String, dynamic> _fixture = jsonDecode(
  File('../../packages/types/fixtures/candidate-search-contract.json')
      .readAsStringSync(),
) as Map<String, dynamic>;

const String _search = 'POST /payer/candidates/search';
const String _filters = 'GET /payer/candidates/filters';
const String _unlocks = 'GET /payer/unlocks';

void main() {
  group('searchCandidates — POST /payer/candidates/search', () {
    test('sends the snake_case body with the bearer, parses the camelCase page',
        () async {
      final h = _harness(<String, http.Response>{
        _search: _json(_fixture['response'] as Object),
      });

      final CandidateSearchPage page = await h.api.searchCandidates(
        const CandidateSearchQuery(
          skillIds: <String>['mskill_cnc_turner'],
          experience: '1_3',
          industryId: 'ind_industrial_manufacturing',
          industryExperience: '3_5',
          city: 'Pune',
          strict: true,
          cursor: 'c-1',
        ),
      );

      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/candidates/search');
      expect(req.headers['authorization'], 'Bearer tok-abc');
      expect(jsonDecode(req.body), <String, dynamic>{
        'skill_ids': <String>['mskill_cnc_turner'],
        'experience': '1_3',
        'industry_id': 'ind_industrial_manufacturing',
        'industry_experience': '3_5',
        'city': 'Pune',
        'strict': true,
        'cursor': 'c-1',
      });
      // XB-A: the payer is the session — never a body key.
      expect((jsonDecode(req.body) as Map<String, dynamic>).containsKey('payer_id'),
          isFalse);

      expect(page.total, 62);
      expect(page.matched, 14);
      expect(page.unrecorded, 9);
      expect(page.filtered, isTrue);
      expect(page.candidates.map((CandidateSearchRow r) => r.workerId),
          <String>[
            'face2000-0000-4000-8000-000000000003',
            'face2000-0000-4000-8000-000000000007',
          ]);
      expect(page.nextCursor, isNotNull);
    });

    test('the unfiltered first page sends {} — no nulls, no empty lists',
        () async {
      final h = _harness(<String, http.Response>{
        _search: _json(_fixture['response'] as Object),
      });

      await h.api.searchCandidates(const CandidateSearchQuery());

      expect(jsonDecode(h.router.seen.single.body), <String, dynamic>{});
    });

    test('a non-2xx keeps its status: 429 cap, 400 refused, 5xx outage',
        () async {
      for (final int status in <int>[400, 401, 429, 500, 503]) {
        final h = _harness(<String, http.Response>{
          _search: _json(<String, dynamic>{'message': 'nope'}, status),
        });
        await expectLater(
          h.api.searchCandidates(const CandidateSearchQuery()),
          throwsA(isA<PayerApiException>().having(
              (PayerApiException e) => e.statusCode, 'statusCode', status)),
          reason: 'a $status must never decode to an empty page',
        );
      }
    });

    test('#370: a 2xx that is not the contract throws — never "nobody here"',
        () async {
      final List<http.Response> bad = <http.Response>[
        http.Response('<html>Sign in to Wi-Fi</html>', 200),
        _json(<String, dynamic>{}),
        _json(<String, dynamic>{'total': 3, 'matched': 3, 'unrecorded': 0}),
        _json(<String, dynamic>{
          'total': 'many',
          'matched': 0,
          'unrecorded': 0,
          'filtered': false,
          'strict': false,
          'candidates': <dynamic>[],
        }),
      ];
      for (final http.Response body in bad) {
        final h = _harness(<String, http.Response>{_search: body});
        await expectLater(
          h.api.searchCandidates(const CandidateSearchQuery()),
          throwsA(isA<PayerApiException>()),
        );
      }
    });

    test('a broken row is dropped; the rest of the page survives', () async {
      final Map<String, dynamic> body = Map<String, dynamic>.of(
          _fixture['response'] as Map<String, dynamic>);
      body['candidates'] = <dynamic>[
        <String, dynamic>{'matchesFilters': true}, // no workerId, no role
        ...(body['candidates'] as List<dynamic>),
      ];
      final h = _harness(<String, http.Response>{_search: _json(body)});

      final CandidateSearchPage page =
          await h.api.searchCandidates(const CandidateSearchQuery());

      expect(page.candidates, hasLength(2));
    });
  });

  group('fetchCandidateFilters — GET /payer/candidates/filters', () {
    test('parses the option lists', () async {
      final h = _harness(<String, http.Response>{
        _filters: _json(_fixture['filters'] as Object),
      });

      final CandidateFilters f = await h.api.fetchCandidateFilters();

      expect(h.router.seen.single.method, 'GET');
      expect(f.roles.map((CandidateRoleOption r) => r.label),
          <String>['CNC Turner', 'VMC Operator']);
      expect(f.roleLabel('mskill_vmc_operator'), 'VMC Operator');
      expect(f.bucketLabel('10_plus'), '10+ years');
      expect(f.cities, <String>['Chennai', 'Pune']);
    });

    test('a 5xx or a non-contract 2xx throws', () async {
      for (final http.Response res in <http.Response>[
        _json(<String, dynamic>{}, 500),
        _json(<String, dynamic>{}),
      ]) {
        final h = _harness(<String, http.Response>{_filters: res});
        await expectLater(
          h.api.fetchCandidateFilters(),
          throwsA(isA<PayerApiException>()),
        );
      }
    });
  });

  group('fetchOwnUnlocks — GET /payer/unlocks (typed rows)', () {
    test('parses the payer view; only granted/revealed in-window rows are live',
        () async {
      final h = _harness(<String, http.Response>{
        _unlocks: _json(<String, dynamic>{
          'unlocks': <dynamic>[
            <String, dynamic>{
              'unlock_id': 'u-granted',
              'worker_id': 'w-1',
              'status': 'granted',
              'expires_at': '2026-11-10T00:00:00.000Z',
            },
            <String, dynamic>{
              'unlock_id': 'u-revealed',
              'worker_id': 'w-2',
              'status': 'revealed',
              'expires_at': '2026-11-10T00:00:00.000Z',
            },
            <String, dynamic>{
              'unlock_id': 'u-expired',
              'worker_id': 'w-3',
              'status': 'expired',
              'expires_at': '2026-10-01T00:00:00.000Z',
            },
            <String, dynamic>{
              'unlock_id': 'u-revoked',
              'worker_id': 'w-4',
              'status': 'revoked',
            },
            // A live status whose window already lapsed (a device clock ahead
            // of the read) — not offered as unlocked.
            <String, dynamic>{
              'unlock_id': 'u-lapsed',
              'worker_id': 'w-5',
              'status': 'granted',
              'expires_at': '2026-11-01T00:00:00.000Z',
            },
            <String, dynamic>{'worker_id': 'w-6', 'status': 'granted'},
          ],
        }),
      });

      final List<PayerUnlock> rows = await h.api.fetchOwnUnlocks();
      final DateTime now = DateTime.utc(2026, 11, 3, 12);

      expect(rows.map((PayerUnlock u) => u.unlockId), <String>[
        'u-granted',
        'u-revealed',
        'u-expired',
        'u-revoked',
        'u-lapsed',
      ], reason: 'a row with no unlock id is unusable and dropped');
      expect(
        rows.where((PayerUnlock u) => u.isLiveAt(now)).map((PayerUnlock u) => u.workerId),
        <String>['w-1', 'w-2'],
      );
    });

    test('a 5xx or a 2xx without the list throws (never "you hold none")',
        () async {
      for (final http.Response res in <http.Response>[
        _json(<String, dynamic>{}, 503),
        _json(<String, dynamic>{'nope': true}),
      ]) {
        final h = _harness(<String, http.Response>{_unlocks: res});
        await expectLater(
          h.api.fetchOwnUnlocks(),
          throwsA(isA<PayerApiException>()),
        );
      }
    });
  });

  group('unlock + masked résumé for a SEARCH row (no posting context)', () {
    test('unlock without a job omits job_id; disclose omits job_posting_id',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/unlocks': _json(<String, dynamic>{
          'ok': true,
          'unlock_id': 'u-9',
          'status': 'granted',
        }),
        'POST /payer/resume-disclosures': _json(<String, dynamic>{
          'ok': true,
          'disclosure_id': 'd-9',
          'resume_url': 'https://signed.example/r.pdf',
        }),
      });

      await h.api.unlock(
          workerId: 'face2000-0000-4000-8000-000000000003', jobId: null);
      await h.api.disclose(workerId: 'face2000-0000-4000-8000-000000000003');

      final Map<String, dynamic> unlockBody =
          jsonDecode(h.router.seen[0].body) as Map<String, dynamic>;
      final Map<String, dynamic> discloseBody =
          jsonDecode(h.router.seen[1].body) as Map<String, dynamic>;
      expect(unlockBody,
          <String, dynamic>{'worker_id': 'face2000-0000-4000-8000-000000000003'});
      expect(discloseBody,
          <String, dynamic>{'worker_id': 'face2000-0000-4000-8000-000000000003'});
    });
  });
}

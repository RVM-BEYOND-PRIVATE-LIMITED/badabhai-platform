import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/features/jobs/presentation/cubit/jobs_cubit.dart';

/// PASS P3 — company job-postings CRUD + lifecycle + monetization, and the
/// credits balance/ledger/purchase, over `HttpPayerApiClient` driven by a mock
/// `http.Client`. Verifies snake_case IN / camelCase OUT, the exactly-one
/// vacancy rule, no body `payer_id`, honest 409 handling, and the credit-ledger
/// snake parse.
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

const String _jobId = '11111111-1111-4111-8111-111111111111';

void main() {
  group('P3 — createCompanyJob', () {
    test('snake body (org_label/role_title/vacancy_band), camelCase parse, '
        'no payer_id', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/job-postings': _json(<String, dynamic>{
          'id': 'job-1',
          'createdBy': 'u-1',
          'payerId': 'p',
          'orgLabel': 'Kalyani Industries',
          'roleTitle': 'CNC Setter',
          'locationLabel': 'Pimpri, Pune',
          'description': null,
          'vacancyBand': '2-5',
          'status': 'draft',
          'createdAt': '2026-07-08T00:00:00Z',
          'updatedAt': '2026-07-08T00:00:00Z',
          'closedAt': null,
        }, 201),
      });

      final JobPosting job = await h.api.createCompanyJob(
        orgLabel: 'Kalyani Industries',
        roleTitle: 'CNC Setter',
        locationLabel: 'Pimpri, Pune',
        vacancyBand: '2-5',
      );

      expect(job.id, 'job-1');
      expect(job.title, 'CNC Setter');
      expect(job.band, '2-5');
      expect(job.locationLabel, 'Pimpri, Pune');
      expect(job.wireStatus, 'draft');
      expect(job.status, JobStatus.review); // draft → review slot

      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/job-postings');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body['org_label'], 'Kalyani Industries');
      expect(body['role_title'], 'CNC Setter');
      expect(body['location_label'], 'Pimpri, Pune');
      expect(body['vacancy_band'], '2-5');
      expect(body.containsKey('vacancies'), isFalse);
      expect(body.containsKey('payer_id'), isFalse);
    });

    test('vacancies path sends an int, not a band', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/job-postings': _json(<String, dynamic>{
          'id': 'job-2',
          'roleTitle': 'VMC Setter',
          'vacancyBand': '1',
          'status': 'draft',
        }, 201),
      });

      await h.api.createCompanyJob(
        orgLabel: 'Kalyani',
        roleTitle: 'VMC Setter',
        vacancies: 3,
      );

      final Map<String, dynamic> body =
          jsonDecode(h.router.seen.single.body) as Map<String, dynamic>;
      expect(body['vacancies'], 3);
      expect(body.containsKey('vacancy_band'), isFalse);
    });

    test('exactly-one vacancy rule — both or neither throws ArgumentError',
        () async {
      final h = _harness(<String, http.Response>{});

      expect(
        () => h.api.createCompanyJob(orgLabel: 'x', roleTitle: 'y'),
        throwsArgumentError,
      );
      expect(
        () => h.api.createCompanyJob(
          orgLabel: 'x',
          roleTitle: 'y',
          vacancyBand: '1',
          vacancies: 2,
        ),
        throwsArgumentError,
      );
      // Neither call reached the wire.
      expect(h.router.seen, isEmpty);
    });
  });

  group('P3 — list + lifecycle', () {
    test('fetchJobs maps rows incl. wireStatus', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/job-postings': _json(<String, dynamic>{
          'items': <dynamic>[
            <String, dynamic>{
              'id': 'job-9',
              'roleTitle': 'CNC Setter',
              'vacancyBand': '6-10',
              'status': 'paused',
              'createdAt': '2026-06-01T00:00:00Z',
            },
          ],
        }),
      });

      final JobPosting job = (await h.api.fetchJobs()).single;
      expect(job.id, 'job-9');
      expect(job.wireStatus, 'paused');
      // No fabricated quota/counts.
      expect(job.quota, 0);
      expect(job.applicants, 0);
    });

    test('closeJob 200 → row reflects closed; POST path, no body', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/job-postings/$_jobId/close': _json(<String, dynamic>{
          'id': _jobId,
          'roleTitle': 'CNC Setter',
          'vacancyBand': '1',
          'status': 'closed',
        }),
      });

      final JobPosting job = await h.api.closeJob(_jobId);
      expect(job.wireStatus, 'closed');
      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/job-postings/$_jobId/close');
      expect(req.headers['authorization'], 'Bearer tok-abc');
    });

    test('pauseJob 409 → PayerApiException(isConflict)', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/job-postings/$_jobId/pause':
            _json(<String, dynamic>{'message': 'not open'}, 409),
      });

      await expectLater(
        h.api.pauseJob(_jobId),
        throwsA(
          isA<PayerApiException>().having(
            (PayerApiException e) => e.isConflict,
            'isConflict',
            isTrue,
          ),
        ),
      );
    });

    test('updateJob publish → PATCH status:open', () async {
      final h = _harness(<String, http.Response>{
        'PATCH /payer/job-postings/$_jobId': _json(<String, dynamic>{
          'id': _jobId,
          'roleTitle': 'CNC Setter',
          'vacancyBand': '1',
          'status': 'open',
        }),
      });

      final JobPosting job = await h.api.updateJob(_jobId, status: 'open');
      expect(job.wireStatus, 'open');
      expect(job.status, JobStatus.live);
      final http.Request req = h.router.seen.single;
      expect(req.method, 'PATCH');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body['status'], 'open');
    });
  });

  group('P3 — monetization', () {
    test('buyPlan → POST /plan {tier}; parses quota + finalInr', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/job-postings/$_jobId/plan': _json(<String, dynamic>{
          'plan': <String, dynamic>{
            'id': 'plan-1',
            'applicantVisibilityQuota': 50,
            'status': 'active',
          },
          'quote': <String, dynamic>{'finalInr': 4999},
          'paused': false,
          'wouldPause': false,
        }, 201),
      });

      final PlanPurchase p = await h.api.buyPlan(_jobId, tier: 'standard');
      expect(p.applicantVisibilityQuota, 50);
      expect(p.status, 'active');
      expect(p.finalInr, 4999);
      expect(p.paused, isFalse);
      expect(p.wouldPause, isFalse);

      final http.Request req = h.router.seen.single;
      expect(req.url.path, '/payer/job-postings/$_jobId/plan');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body['tier'], 'standard');
      expect(body.containsKey('payer_id'), isFalse);
    });

    test('buyBoost → POST /boost with default tier; 409 active boost', () async {
      final ok = _harness(<String, http.Response>{
        'POST /payer/job-postings/$_jobId/boost': _json(<String, dynamic>{
          'boost': <String, dynamic>{'id': 'b-1', 'status': 'active'},
          'quote': <String, dynamic>{'finalInr': 999},
        }, 201),
      });
      final BoostPurchase b = await ok.api.buyBoost(_jobId);
      expect(b.status, 'active');
      expect(b.finalInr, 999);
      final Map<String, dynamic> body =
          jsonDecode(ok.router.seen.single.body) as Map<String, dynamic>;
      expect(body['tier'], 'all_candidates');

      final conflict = _harness(<String, http.Response>{
        'POST /payer/job-postings/$_jobId/boost':
            _json(<String, dynamic>{'message': 'active boost'}, 409),
      });
      await expectLater(
        conflict.api.buyBoost(_jobId),
        throwsA(isA<PayerApiException>()),
      );
    });

    test('quotaTopup → POST /quota-topup {tier}; 409 no active plan', () async {
      final ok = _harness(<String, http.Response>{
        'POST /payer/job-postings/$_jobId/quota-topup': _json(<String, dynamic>{
          'plan': <String, dynamic>{
            'applicantVisibilityQuota': 25,
            'status': 'active',
          },
          'quote': <String, dynamic>{'finalInr': 1999},
        }, 201),
      });
      // A VALID quota_topup code — 'standard' is a PLAN tier and would 400.
      final PlanPurchase p = await ok.api.quotaTopup(_jobId, tier: 'topup_10');
      expect(p.applicantVisibilityQuota, 25);
      expect(p.finalInr, 1999);
      expect(ok.router.seen.single.url.path,
          '/payer/job-postings/$_jobId/quota-topup');
      final Map<String, dynamic> topupBody =
          jsonDecode(ok.router.seen.single.body) as Map<String, dynamic>;
      expect(topupBody['tier'], 'topup_10');

      final conflict = _harness(<String, http.Response>{
        'POST /payer/job-postings/$_jobId/quota-topup':
            _json(<String, dynamic>{'message': 'no plan'}, 409),
      });
      await expectLater(
        conflict.api.quotaTopup(_jobId, tier: 'topup_30'),
        throwsA(
          isA<PayerApiException>()
              .having((PayerApiException e) => e.isConflict, 'isConflict', true),
        ),
      );
    });

    test('JobsCubit.topup forwards a valid quota_topup tier to the wire',
        () async {
      final h = _harness(<String, http.Response>{
        // The list refetch that follows a successful top-up.
        'GET /payer/job-postings': _json(<String, dynamic>{'items': <dynamic>[]}),
        'POST /payer/job-postings/$_jobId/quota-topup': _json(<String, dynamic>{
          'plan': <String, dynamic>{
            'applicantVisibilityQuota': 10,
            'status': 'active',
          },
          'quote': <String, dynamic>{'finalInr': 1000},
        }, 201),
      });

      final JobsCubit cubit = JobsCubit(h.api);
      final JobActionResult result = await cubit.topup(_jobId, 'topup_10');

      expect(result.success, isTrue);
      final http.Request topup = h.router.seen.firstWhere(
          (http.Request r) => r.url.path.endsWith('/quota-topup'));
      final Map<String, dynamic> body =
          jsonDecode(topup.body) as Map<String, dynamic>;
      // The screen sends topup_10 / topup_30 — NEVER a plan tier like 'standard'.
      expect(body['tier'], 'topup_10');
      expect(<String>['topup_10', 'topup_30'], contains(body['tier']));
    });
  });

  group('P3 — credits', () {
    test('fetchCreditBalance → GET /payer/credits {balance}', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/credits':
            _json(<String, dynamic>{'payer_id': 'p', 'balance': 173}),
      });
      expect(await h.api.fetchCreditBalance(), 173);
    });

    test('buyCreditPack → POST {pack_code}; returns new balance; unknown=404',
        () async {
      final ok = _harness(<String, http.Response>{
        'POST /payer/credits': _json(<String, dynamic>{
          'payer_id': 'p',
          'balance': 250,
          'credits': 200,
          'pack_code': 'pack_200',
        }, 201),
      });
      final int balance = await ok.api.buyCreditPack(packCode: 'pack_200');
      expect(balance, 250);
      final Map<String, dynamic> body =
          jsonDecode(ok.router.seen.single.body) as Map<String, dynamic>;
      expect(body['pack_code'], 'pack_200');
      expect(body.containsKey('payer_id'), isFalse);

      final unknown = _harness(<String, http.Response>{
        'POST /payer/credits':
            _json(<String, dynamic>{'message': 'unknown pack'}, 404),
      });
      await expectLater(
        unknown.api.buyCreditPack(packCode: 'pack_x'),
        throwsA(
          isA<PayerApiException>()
              .having((PayerApiException e) => e.isNotFound, 'isNotFound', true),
        ),
      );
    });

    test('fetchCreditLedger → GET /credits/ledger snake parse', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/credits/ledger': _json(<String, dynamic>{
          'payer_id': 'p',
          'ledger': <dynamic>[
            <String, dynamic>{
              'id': 'l1',
              'delta': 200,
              'reason': 'pack_purchase',
              'unlock_id': null,
              'pack_code': 'pack_200',
              'payment_ref': 'pay_1',
              'created_at': '2026-07-08T00:00:00Z',
            },
            <String, dynamic>{
              'id': 'l2',
              'delta': -1,
              'reason': 'unlock_debit',
              'unlock_id': 'u1',
              'pack_code': null,
              'payment_ref': null,
              'created_at': '2026-07-08T01:00:00Z',
            },
          ],
        }),
      });

      final List<LedgerEntry> ledger = await h.api.fetchCreditLedger();
      expect(ledger, hasLength(2));
      expect(ledger.first.direction, LedgerDirection.credit);
      expect(ledger.first.amount, '+200');
      expect(ledger.first.label, 'Pack purchase · pack_200');
      expect(ledger[1].direction, LedgerDirection.debit);
      expect(ledger[1].amount, '−1');
      expect(ledger[1].label, 'Unlock');
      // limit passed on the query.
      expect(h.router.seen.single.url.query, contains('limit=20'));
    });
  });
}

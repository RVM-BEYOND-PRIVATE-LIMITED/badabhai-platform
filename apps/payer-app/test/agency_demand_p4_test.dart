import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';

/// PASS P4a — AGENCY demand (agent-only): agency jobs create/list/lifecycle +
/// the referral funnel summary, over `HttpPayerApiClient` driven by a mock
/// `http.Client`. Verifies snake_case IN (trade_key/pay_min/...), camelCase OUT,
/// the BARE-array list (wrapped under `items` by PayerHttp), the pause GOTCHA
/// (returns status:'closed'), no body `payer_id`, and the k-anon summary parse.
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
  tokens.save(accessToken: 'tok-agent', payerId: 'p', role: 'agent');
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

const String _jobId = '22222222-2222-4222-8222-222222222222';

Map<String, dynamic> _row({
  required String id,
  String status = 'open',
  String tradeKey = 'cnc_operator',
  String title = 'CNC Operator',
  String city = 'Pune',
  String? area,
  int? payMin,
  int? payMax,
  int? minExp,
  int? maxExp,
  String? neededBy,
  int applicants = 0,
}) =>
    <String, dynamic>{
      'id': id,
      'status': status,
      'tradeKey': tradeKey,
      'title': title,
      'city': city,
      'area': area,
      'payMin': payMin,
      'payMax': payMax,
      'minExperienceYears': minExp,
      'maxExperienceYears': maxExp,
      'neededBy': neededBy,
      'applicantsReceived': applicants,
      'createdAt': '2026-07-08T00:00:00Z',
      'updatedAt': '2026-07-08T00:00:00Z',
    };

void main() {
  group('P4a — createAgencyJob', () {
    test('snake body (trade_key/pay_min/...), camelCase parse, no payer_id',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/jobs': _json(
          _row(
            id: _jobId,
            tradeKey: 'cnc_vmc_setter',
            title: 'CNC / VMC Setter',
            city: 'Pune',
            area: 'Chakan',
            payMin: 22000,
            payMax: 28000,
            minExp: 2,
            maxExp: 6,
            neededBy: 'immediate',
            applicants: 0,
          ),
          201,
        ),
      });

      final AgencyJobView job = await h.api.createAgencyJob(
        tradeKey: 'cnc_vmc_setter',
        title: 'CNC / VMC Setter',
        city: 'Pune',
        area: 'Chakan',
        payMin: 22000,
        payMax: 28000,
        minExperienceYears: 2,
        maxExperienceYears: 6,
        neededBy: 'immediate',
      );

      expect(job.id, _jobId);
      expect(job.status, 'open');
      expect(job.tradeKey, 'cnc_vmc_setter');
      expect(job.tradeLabel, 'CNC / VMC Setter');
      expect(job.payRangeLabel, '₹22,000–₹28,000');
      expect(job.experienceLabel, '2–6 yrs');
      expect(job.neededBy, 'immediate');

      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/agency/jobs');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body['trade_key'], 'cnc_vmc_setter');
      expect(body['title'], 'CNC / VMC Setter');
      expect(body['city'], 'Pune');
      expect(body['area'], 'Chakan');
      expect(body['pay_min'], 22000);
      expect(body['pay_max'], 28000);
      expect(body['min_experience_years'], 2);
      expect(body['max_experience_years'], 6);
      expect(body['needed_by'], 'immediate');
      // Never a body payer_id (server derives the tenant from the bearer).
      expect(body.containsKey('payer_id'), isFalse);
      expect(req.headers['authorization'], 'Bearer tok-agent');
    });

    test('optional bands omitted → not sent on the wire', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/jobs': _json(_row(id: _jobId), 201),
      });

      await h.api.createAgencyJob(
        tradeKey: 'cnc_operator',
        title: 'CNC Operator',
        city: 'Pune',
      );

      final Map<String, dynamic> body =
          jsonDecode(h.router.seen.single.body) as Map<String, dynamic>;
      expect(body.keys, containsAll(<String>['trade_key', 'title', 'city']));
      expect(body.containsKey('area'), isFalse);
      expect(body.containsKey('pay_min'), isFalse);
      expect(body.containsKey('needed_by'), isFalse);
    });

    test('400 (bad band ordering / invalid trade) → PayerApiException',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/jobs':
            _json(<String, dynamic>{'message': 'pay_max must be >= pay_min'}, 400),
      });
      await expectLater(
        h.api.createAgencyJob(
          tradeKey: 'cnc_operator',
          title: 'x',
          city: 'Pune',
          payMin: 30000,
          payMax: 10000,
        ),
        throwsA(
          isA<PayerApiException>()
              .having((PayerApiException e) => e.isBadRequest, 'isBadRequest', true),
        ),
      );
    });
  });

  group('P4a — list + lifecycle', () {
    test('fetchAgencyJobs parses a BARE array (wrapped under items)', () async {
      final h = _harness(<String, http.Response>{
        // BARE top-level array — PayerHttp._decode wraps it under `items`.
        'GET /payer/agency/jobs': _json(<dynamic>[
          _row(id: 'a1', title: 'CNC Operator', applicants: 7),
          _row(id: 'a2', status: 'closed', title: 'Setter', applicants: 3),
        ]),
      });

      final List<AgencyJobView> jobs = await h.api.fetchAgencyJobs();
      expect(jobs, hasLength(2));
      expect(jobs.first.id, 'a1');
      expect(jobs.first.applicantsReceived, 7);
      expect(jobs[1].isClosed, isTrue);
      expect(h.router.seen.single.url.path, '/payer/agency/jobs');
    });

    test('getAgencyJob neutral 404 → null (no oracle)', () async {
      final h = _harness(<String, http.Response>{});
      expect(await h.api.getAgencyJob(_jobId), isNull);
    });

    test('closeAgencyJob 200 → status closed; POST path, no body', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/jobs/$_jobId/close':
            _json(_row(id: _jobId, status: 'closed')),
      });

      final AgencyJobView job = await h.api.closeAgencyJob(_jobId);
      expect(job.isClosed, isTrue);
      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/agency/jobs/$_jobId/close');
      expect(req.body, isEmpty);
    });

    test('pauseAgencyJob GOTCHA — the returned status is "closed"', () async {
      final h = _harness(<String, http.Response>{
        // Phase-1 has no `paused` literal: a pause returns status:'closed'.
        'POST /payer/agency/jobs/$_jobId/pause':
            _json(_row(id: _jobId, status: 'closed')),
      });

      final AgencyJobView job = await h.api.pauseAgencyJob(_jobId);
      expect(job.status, 'closed');
      expect(job.isOpen, isFalse);
      expect(h.router.seen.single.url.path, '/payer/agency/jobs/$_jobId/pause');
    });

    test('updateAgencyJob sends a snake patch; empty patch throws', () async {
      final h = _harness(<String, http.Response>{
        'PATCH /payer/agency/jobs/$_jobId':
            _json(_row(id: _jobId, title: 'New title')),
      });

      final AgencyJobView job =
          await h.api.updateAgencyJob(_jobId, title: 'New title', payMin: 25000);
      expect(job.title, 'New title');
      final Map<String, dynamic> body =
          jsonDecode(h.router.seen.single.body) as Map<String, dynamic>;
      expect(body['title'], 'New title');
      expect(body['pay_min'], 25000);
      expect(body.containsKey('payer_id'), isFalse);

      final empty = _harness(<String, http.Response>{});
      expect(() => empty.api.updateAgencyJob(_jobId), throwsArgumentError);
      expect(empty.router.seen, isEmpty);
    });
  });

  group('P4a — referral funnel summary', () {
    test('fetchReferralsSummary parses the k-anon aggregate', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/agency/referrals/summary': _json(<String, dynamic>{
          'created': 24,
          'clicked': 11,
          'accepted': 6,
          'minBucket': 5,
        }),
      });

      final ReferralsSummary s = await h.api.fetchReferralsSummary();
      expect(s.created, 24);
      expect(s.clicked, 11);
      expect(s.accepted, 6);
      expect(s.minBucket, 5);
      expect(h.router.seen.single.url.path, '/payer/agency/referrals/summary');
    });

    test('referralLink POSTs the invite route with no payer_id', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/invites': _json(<String, dynamic>{
          'agency_invite_id': 'inv-1',
          'code': 'abc123def456',
          'link': '/i/abc123def456',
        }, 201),
      });

      final ReferralLink link = await h.api.referralLink();
      expect(link.code, 'abc123def456');
      expect(link.url, '/i/abc123def456');
      final Map<String, dynamic> body =
          jsonDecode(h.router.seen.single.body) as Map<String, dynamic>;
      expect(body.containsKey('payer_id'), isFalse);
    });
  });
}

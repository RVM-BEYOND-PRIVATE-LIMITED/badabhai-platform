import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';

/// A [MockClient] routed by `METHOD path` → response, recording every request.
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
  // A bearer so the client attaches it; assert it on the wire below.
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

void main() {
  group('HttpPayerApiClient — bound endpoints', () {
    test('fetchCredits → GET /payer/credits {balance}, with bearer', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/credits': _json(<String, dynamic>{'balance': 42}),
      });

      final int balance = await h.api.fetchCredits();

      expect(balance, 42);
      final http.Request req = h.router.seen.single;
      expect(req.method, 'GET');
      expect(req.headers['authorization'], 'Bearer tok-abc');
    });

    test('buyCredits maps count→pack_code, POST /payer/credits', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/credits': _json(<String, dynamic>{'balance': 250}),
      });

      final int balance = await h.api.buyCredits(200);

      expect(balance, 250);
      final http.Request req = h.router.seen.single;
      expect(req.url.path, '/payer/credits');
      expect(jsonDecode(req.body),
          <String, dynamic>{'pack_code': 'pack_200'});
    });

    test('fetchLedger → GET /payer/unlocks maps {unlocks:[...]}', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/unlocks': _json(<String, dynamic>{
          'unlocks': <dynamic>[
            <String, dynamic>{'unlock_id': 'u1', 'worker_id': 'w-993210'},
            <String, dynamic>{'unlock_id': 'u2', 'worker_id': 'ab'},
          ],
        }),
      });

      final List<LedgerEntry> ledger = await h.api.fetchLedger();

      expect(ledger, hasLength(2));
      expect(ledger.first.label, 'Unlock ••• 3210');
      expect(ledger.first.direction, LedgerDirection.debit);
      expect(ledger.first.amount, '−1');
    });

    test('fetchJobs maps rows; quota/applicants/verified stay defaults',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/job-postings': _json(<String, dynamic>{
          'items': <dynamic>[
            <String, dynamic>{
              'id': 'job-1',
              'roleTitle': 'CNC Setter',
              'vacancyBand': '2-5',
              'locationLabel': 'Pimpri, Pune',
              'status': 'open',
              'createdAt': '2026-06-01T00:00:00Z',
            },
          ],
        }),
      });

      final List<JobPosting> jobs = await h.api.fetchJobs();

      final JobPosting job = jobs.single;
      expect(job.id, 'job-1');
      expect(job.title, 'CNC Setter');
      expect(job.band, '2-5');
      expect(job.locationLabel, 'Pimpri, Pune');
      expect(job.createdAt, '2026-06-01T00:00:00Z');
      expect(job.status, JobStatus.live); // open → live
      // NOT faked — server has no quota/applicants/verified/boost.
      expect(job.quota, 0);
      expect(job.applicants, 0);
      expect(job.unlocks, 0);
      expect(job.verified, isFalse);
      expect(job.boosted, isFalse);
    });

    test('unlockCandidate success → re-reads server-truth credits', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/unlocks': _json(<String, dynamic>{
          'ok': true,
          'unlock_id': 'u-9',
          'status': 'granted',
          'expires_at': '2026-07-01T00:00:00Z',
        }),
        'GET /payer/credits': _json(<String, dynamic>{'balance': 199}),
      });

      final int balance = await h.api.unlockCandidate(5);

      expect(balance, 199);
      // worker_id sent, NO payer_id in the body.
      final http.Request unlock = h.router.seen
          .firstWhere((http.Request r) => r.url.path == '/payer/unlocks');
      final Map<String, dynamic> body =
          jsonDecode(unlock.body) as Map<String, dynamic>;
      expect(body['worker_id'], '5');
      expect(body.containsKey('payer_id'), isFalse);
    });

    test('unlockCandidate 200 {status:"unavailable"} = neutral DENY', () async {
      final h = _harness(<String, http.Response>{
        // Deny comes back as HTTP 200 — must NOT be trusted as a grant.
        'POST /payer/unlocks':
            _json(<String, dynamic>{'status': 'unavailable'}, 200),
        'GET /payer/credits': _json(<String, dynamic>{'balance': 200}),
      });

      final int balance = await h.api.unlockCandidate(7);

      // No change: balance is whatever the server still reports.
      expect(balance, 200);
    });

    test('referralLink → POST /payer/agency/invites {code,link}', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/invites': _json(<String, dynamic>{
          'agency_invite_id': 'inv-1',
          'code': 'APEX-7K2',
          'link': '/i/APEX-7K2',
        }),
      });

      final ReferralLink link = await h.api.referralLink();

      expect(link.code, 'APEX-7K2');
      expect(link.url, '/i/APEX-7K2');
    });
  });

  group('HttpPayerApiClient — read-method isSuccess guards', () {
    // A neutral 404 on the applicants feed stays an EMPTY feed (no-oracle) —
    // never an exception.
    test('fetchApplicants 404 → empty feed (neutral, no throw)', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/reach/jobs/job-1/applicants': _json(<String, dynamic>{}, 404),
      });

      final List<Applicant> applicants = await h.api.fetchApplicants('job-1');

      expect(applicants, isEmpty);
    });

    // A 429 (per-payer hourly cap) or a 5xx must NOT masquerade as "no
    // applicants" — it throws so the cubit shows an error/retry.
    test('fetchApplicants 429 (cap) → PayerApiException, not a false empty',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/reach/jobs/job-1/applicants':
            _json(<String, dynamic>{'message': 'rate limited'}, 429),
      });

      await expectLater(
        h.api.fetchApplicants('job-1'),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'statusCode', 429)),
      );
    });

    test('fetchApplicants 500 → PayerApiException', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/reach/jobs/job-1/applicants':
            _json(<String, dynamic>{}, 500),
      });
      await expectLater(
          h.api.fetchApplicants('job-1'), throwsA(isA<PayerApiException>()));
    });

    // Every list/view GET that used to decode the body unconditionally now
    // throws on a real server error instead of fabricating an empty/zero model
    // shown as a "ready" success.
    test('list/view GETs throw PayerApiException on a 5xx (no fabricated zeros)',
        () async {
      Future<void> expectThrows(
        String routeKey,
        Future<void> Function(HttpPayerApiClient) call,
      ) async {
        final h = _harness(<String, http.Response>{
          routeKey: _json(<String, dynamic>{'message': 'boom'}, 500),
        });
        await expectLater(call(h.api), throwsA(isA<PayerApiException>()));
      }

      await expectThrows(
          'GET /payer/job-postings', (HttpPayerApiClient a) => a.fetchJobs());
      await expectThrows('GET /payer/credits',
          (HttpPayerApiClient a) => a.fetchCreditBalance());
      await expectThrows('GET /payer/credits/ledger',
          (HttpPayerApiClient a) => a.fetchCreditLedger());
      await expectThrows(
          'GET /payer/unlocks', (HttpPayerApiClient a) => a.fetchLedger());
      await expectThrows('GET /payer/agency/jobs',
          (HttpPayerApiClient a) => a.fetchAgencyJobs());
      await expectThrows('GET /payer/agency/referrals/summary',
          (HttpPayerApiClient a) => a.fetchReferralsSummary());
      await expectThrows(
          'GET /payer/org/members', (HttpPayerApiClient a) => a.fetchOrgMembers());
      await expectThrows(
          'GET /payer/capacity', (HttpPayerApiClient a) => a.fetchCapacity());
    });
  });

  group('HttpPayerApiClient — delegated to mock (deferred / design-only)', () {
    test('fetchCandidates delegates (no HTTP call)', () async {
      final h = _harness(<String, http.Response>{});
      final List<Candidate> candidates = await h.api.fetchCandidates();
      // Mock seed has 6 candidates; no network request was made.
      expect(candidates, isNotEmpty);
      expect(h.router.seen, isEmpty);
    });

    test('design-only KYC/payouts/referred delegate to the mock', () async {
      final h = _harness(<String, http.Response>{});

      expect(await h.api.kycStatus(), KycStatus.none);
      expect((await h.api.fetchPayouts()), isNotEmpty);
      expect((await h.api.fetchReferredWorkers()), isNotEmpty);
      final PayoutSummary summary = await h.api.fetchPayoutSummary();
      expect(summary.totalEarned, isNotEmpty);
      // None of these touched the wire.
      expect(h.router.seen, isEmpty);
    });
  });
}

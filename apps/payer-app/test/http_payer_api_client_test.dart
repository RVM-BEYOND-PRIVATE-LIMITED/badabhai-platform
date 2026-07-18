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

    // #370 — the non-2xx guard below is not enough on its own: PayerHttp._decode
    // turns ANY unparseable/non-object body into `{}`, so a 200 carrying
    // captive-portal HTML (or a drifted contract) sailed past it and `?? 0` then
    // minted a confident "0 credits" — telling the payer their balance was wiped.
    test('#370: a 2xx with a malformed/contract-breaking body throws instead of '
        'fabricating a 0 balance', () async {
      final List<http.Response> badBodies = <http.Response>[
        // Captive-portal HTML served as 200.
        http.Response('<html><body>Sign in to WiFi</body></html>', 200),
        // Valid JSON, but not an object.
        http.Response('[1,2,3]', 200),
        // Object without the contracted key.
        _json(<String, dynamic>{'credits': 42}),
        // Right key, wrong type.
        _json(<String, dynamic>{'balance': 'many'}),
      ];
      for (final http.Response body in badBodies) {
        final h = _harness(<String, http.Response>{'GET /payer/credits': body});
        await expectLater(
          h.api.fetchCreditBalance(),
          throwsA(isA<PayerApiException>()),
          reason: 'an undecodable 200 is a contract error, not a zero balance',
        );
      }
    });

    test('#370: a well-formed 2xx still returns the real balance (incl. a true 0)',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/credits': _json(<String, dynamic>{'balance': 0}),
      });
      // A REAL zero must still pass — the fix rejects missing/garbage, not 0.
      expect(await h.api.fetchCreditBalance(), 0);
    });

    // fetchCredits used to swallow EVERY non-2xx and return 0 — a real 500/401
    // rendered as an honest-looking "0 credits". It must fail instead.
    test('fetchCredits non-2xx → PayerApiException (never a fabricated 0)',
        () async {
      for (final int status in <int>[401, 429, 500]) {
        final h = _harness(<String, http.Response>{
          'GET /payer/credits': _json(<String, dynamic>{'message': 'nope'}, status),
        });
        await expectLater(
          h.api.fetchCredits(),
          throwsA(isA<PayerApiException>()
              .having((PayerApiException e) => e.statusCode, 'statusCode', status)),
        );
      }
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

  // The real client used to COMPOSE a MockPayerApiClient and delegate ~10
  // methods to it with no kUseMocks gate, so a release build served invented
  // home metrics / activity / payouts / KYC / referred rows / credit packs
  // through the "real" client. Those surfaces had no backend route and are gone;
  // the two MOCK-only demo methods that remain must FAIL rather than quietly
  // hand back seed data.
  group('HttpPayerApiClient — no mock fallback survives on the real seam', () {
    test('fetchCandidates throws UnsupportedError (never canned candidates)',
        () async {
      final h = _harness(<String, http.Response>{});
      await expectLater(h.api.fetchCandidates(), throwsUnsupportedError);
      expect(h.router.seen, isEmpty);
    });

    test('unlockCandidate(int) throws UnsupportedError (real unlock is by UUID)',
        () async {
      final h = _harness(<String, http.Response>{});
      await expectLater(h.api.unlockCandidate(5), throwsUnsupportedError);
      expect(h.router.seen, isEmpty);
    });
  });

  group('P5 — the two newly-wired routes', () {
    test('listDisclosures → GET /payer/resume-disclosures, parses rows + bearer',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/resume-disclosures': _json(<String, dynamic>{
          'disclosures': <Map<String, dynamic>>[
            <String, dynamic>{
              'disclosure_id': 'd1',
              'payer_id': 'p',
              'worker_id': 'w-uuid-1',
              'job_posting_id': 'j1',
              'status': 'disclosed',
              'resume_ref': 'ref/masked-1.pdf',
              'disclosed_at': '2026-07-01T10:00:00Z',
              'expires_at': '2026-12-31T00:00:00Z',
              'created_at': '2026-07-01T10:00:00Z',
            },
          ],
        }),
      });

      final List<PayerDisclosure> rows = await h.api.listDisclosures();

      expect(rows, hasLength(1));
      expect(rows.single.disclosureId, 'd1');
      expect(rows.single.workerId, 'w-uuid-1');
      expect(rows.single.status, 'disclosed');
      final http.Request req = h.router.seen.single;
      expect(req.method, 'GET');
      expect(req.url.path, '/payer/resume-disclosures');
      expect(req.headers['authorization'], 'Bearer tok-abc');
      // PII-free by construction: the row is opaque ids + timestamps only — the
      // worker id is a UUID, never a name/phone (no such field exists).
      expect(rows.single.workerId, 'w-uuid-1');
      expect(rows.single.resumeRef, 'ref/masked-1.pdf');
    });

    test('listDisclosures non-2xx → PayerApiException (never a blank list)',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/resume-disclosures': _json(<String, dynamic>{}, 401),
      });
      expect(h.api.listDisclosures(), throwsA(isA<PayerApiException>()));
    });

    test('listDisclosures missing key → empty list (valid "no disclosures")',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/resume-disclosures': _json(<String, dynamic>{}),
      });
      expect(await h.api.listDisclosures(), isEmpty);
    });

    test('recordInviteClick → POST /payer/agency/invites/:code/click, no body',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/agency/invites/ABC123/click':
            _json(<String, dynamic>{'ok': true}),
      });

      await h.api.recordInviteClick('ABC123');

      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/agency/invites/ABC123/click');
      expect(req.headers['authorization'], 'Bearer tok-abc');
    });
  });
}

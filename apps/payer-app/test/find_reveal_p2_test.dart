import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';

/// PASS P2 — the REAL candidate feed + unlock + reveal + masked-résumé
/// disclosure over `HttpPayerApiClient`, driven by a mock `http.Client`.
/// Verifies: the faceless applicant parse (camelCase, no PII), a real worker
/// UUID (never a mock int) on `POST /payer/unlocks`, and that every neutral
/// DENY (`{status:"unavailable"}`) is a typed result — never a false success.
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
const String _workerId = 'a1b2c3d4-5566-4777-8888-99990000abcd';

void main() {
  group('P2 — fetchApplicants (faceless per-job feed)', () {
    test('GET /payer/reach/jobs/:jobId/applicants with bearer, camelCase parse',
        () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/reach/jobs/$_jobId/applicants': _json(<String, dynamic>{
          'jobId': _jobId,
          'applicants': <dynamic>[
            <String, dynamic>{
              'workerId': _workerId,
              'rank': 1,
              'score': 0.92,
              'hot': true,
              'pushEligible': true,
              'components': <dynamic>[
                <String, dynamic>{
                  'signal': 'trade',
                  'raw': 1,
                  'weight': 0.5,
                  'reason': 'Trade matches CNC Setter',
                },
                <String, dynamic>{
                  'signal': 'city',
                  'raw': 1,
                  'weight': 0.3,
                  'reason': 'Same city as the job',
                },
              ],
              'experienceBand': '5-8 yrs',
              'tradeLabel': 'CNC Setter',
              'cityLabel': 'Pune',
            },
          ],
        }),
      });

      final List<Applicant> applicants = await h.api.fetchApplicants(_jobId);

      final http.Request req = h.router.seen.single;
      expect(req.method, 'GET');
      expect(req.url.path, '/payer/reach/jobs/$_jobId/applicants');
      expect(req.headers['authorization'], 'Bearer tok-abc');

      final Applicant a = applicants.single;
      expect(a.workerId, _workerId);
      expect(a.rank, 1);
      expect(a.score, 0.92);
      expect(a.hot, isTrue);
      expect(a.pushEligible, isTrue);
      expect(a.experienceBand, '5-8 yrs');
      expect(a.tradeLabel, 'CNC Setter');
      expect(a.cityLabel, 'Pune');
      // FACELESS: masked label from the UUID (last-4), never a real name.
      expect(a.maskedLabel, 'Worker ••abcd');
      // SOFT signals from reasons only (capped at 2) — no number/score shown.
      expect(a.softSignals(), <String>[
        'Trade matches CNC Setter',
        'Same city as the job',
      ]);
    });

    test('null facets survive (unknown signal → dropped, not faked)', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/reach/jobs/$_jobId/applicants': _json(<String, dynamic>{
          'jobId': _jobId,
          'applicants': <dynamic>[
            <String, dynamic>{
              'workerId': _workerId,
              'rank': 2,
              'score': 0.4,
              'hot': false,
              'pushEligible': false,
              'components': <dynamic>[],
              'experienceBand': null,
              'tradeLabel': null,
              'cityLabel': null,
            },
          ],
        }),
      });

      final Applicant a = (await h.api.fetchApplicants(_jobId)).single;
      expect(a.experienceBand, isNull);
      expect(a.tradeLabel, isNull);
      expect(a.cityLabel, isNull);
      expect(a.softSignals(), isEmpty);
    });
  });

  group('P2 — unlock (real UUID → POST /payer/unlocks)', () {
    test('success → granted with unlock_id; sends worker UUID, no payer_id',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/unlocks': _json(<String, dynamic>{
          'ok': true,
          'unlock_id': 'unlock-99',
          'status': 'granted',
          'expires_at': '2026-07-09T00:00:00Z',
        }),
      });

      final UnlockResult result =
          await h.api.unlock(workerId: _workerId, jobId: _jobId);

      expect(result.granted, isTrue);
      expect(result.unlockId, 'unlock-99');
      expect(result.expiresAt, '2026-07-09T00:00:00Z');

      final http.Request req = h.router.seen.single;
      expect(req.url.path, '/payer/unlocks');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      // The BUG FIX: a real worker UUID string is sent — NOT a mock int.
      expect(body['worker_id'], _workerId);
      expect(body['worker_id'], isA<String>());
      expect(int.tryParse(body['worker_id'] as String), isNull); // not an int
      expect(body['job_id'], _jobId);
      expect(body.containsKey('payer_id'), isFalse);
    });

    test('deny → 200 {status:"unavailable"} is a typed unavailable, not success',
        () async {
      final h = _harness(<String, http.Response>{
        // HTTP 200 with a deny body — must NOT be trusted as a grant.
        'POST /payer/unlocks':
            _json(<String, dynamic>{'status': 'unavailable'}, 200),
      });

      final UnlockResult result = await h.api.unlock(workerId: _workerId);

      expect(result.granted, isFalse);
      expect(result.unlockId, isNull);
    });

    test('unlock without a jobId omits job_id from the body', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/unlocks': _json(<String, dynamic>{
          'ok': true,
          'unlock_id': 'u-1',
          'status': 'granted',
        }),
      });

      await h.api.unlock(workerId: _workerId);

      final Map<String, dynamic> body =
          jsonDecode(h.router.seen.single.body) as Map<String, dynamic>;
      expect(body['worker_id'], _workerId);
      expect(body.containsKey('job_id'), isFalse);
    });
  });

  group('P2 — reveal (relay handle, never a phone)', () {
    test('success → relay handle + channel', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/unlocks/unlock-99/reveal': _json(<String, dynamic>{
          'relay_handle': 'relay-7Q2X',
          'channel': 'in_app_relay',
          'expires_at': '2026-07-09T00:00:00Z',
        }),
      });

      final RevealResult result = await h.api.reveal('unlock-99');

      expect(result.revealed, isTrue);
      expect(result.relayHandle, 'relay-7Q2X');
      expect(result.channel, 'in_app_relay');
      final http.Request req = h.router.seen.single;
      expect(req.method, 'POST');
      expect(req.url.path, '/payer/unlocks/unlock-99/reveal');
      expect(req.headers['authorization'], 'Bearer tok-abc');
    });

    test('deny → {status:"unavailable"} is a typed unavailable', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/unlocks/unlock-99/reveal':
            _json(<String, dynamic>{'status': 'unavailable'}, 200),
      });

      final RevealResult result = await h.api.reveal('unlock-99');

      expect(result.revealed, isFalse);
      expect(result.relayHandle, isNull);
    });
  });

  group('P2 — disclose (masked résumé)', () {
    test('success → signed masked resume_url; sends worker_id + job_posting_id',
        () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/resume-disclosures': _json(<String, dynamic>{
          'ok': true,
          'disclosure_id': 'disc-1',
          'status': 'disclosed',
          'resume_url': 'https://signed.example/resume.pdf',
          'expires_at': '2026-07-09T00:00:00Z',
        }),
      });

      final DisclosureResult result = await h.api.disclose(
        workerId: _workerId,
        jobPostingId: _jobId,
      );

      expect(result.disclosed, isTrue);
      expect(result.resumeUrl, 'https://signed.example/resume.pdf');
      expect(result.disclosureId, 'disc-1');

      final http.Request req = h.router.seen.single;
      expect(req.url.path, '/payer/resume-disclosures');
      final Map<String, dynamic> body =
          jsonDecode(req.body) as Map<String, dynamic>;
      expect(body['worker_id'], _workerId);
      expect(body['job_posting_id'], _jobId);
      expect(body.containsKey('payer_id'), isFalse);
    });

    test('deny → {status:"unavailable"} is a typed unavailable', () async {
      final h = _harness(<String, http.Response>{
        'POST /payer/resume-disclosures':
            _json(<String, dynamic>{'status': 'unavailable'}, 200),
      });

      final DisclosureResult result =
          await h.api.disclose(workerId: _workerId);

      expect(result.disclosed, isFalse);
      expect(result.resumeUrl, isNull);
    });
  });
}

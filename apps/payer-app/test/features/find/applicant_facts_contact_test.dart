import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/candidate_search_models.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';
import 'package:payer_app/core/util/prepay_facts.dart';

/// #2747 — the source label, the six facts before paying, and what a credit opens.
///
/// Pinned: all six null still counts as the part being ON and reads "not given" six times; the
/// salary is printed exactly as sent; the contact read maps 404 → today's screen, the neutral body
/// → nothing new, success → name + number, and a 429 throws for a polite line.
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

void main() {
  group('facts before paying', () {
    test('all six null still reads "not given" six times', () {
      final List<(String, String)> lines = prePayFactLines(
        firstName: null,
        tradeLine: null,
        expectedSalary: null,
        machines: null,
        area: null,
        lastActiveOn: null,
      );
      expect(lines, hasLength(6));
      expect(lines.map((l) => l.$2), everyElement(kNotGiven));
    });

    test('the salary is printed exactly as sent', () {
      expect(salaryText('₹24,000 – ₹28,000 / month'),
          '₹24,000 – ₹28,000 / month');
    });

    test('the source labels are the two the cards show', () {
      expect(applicantSourceLabel('rvm_student'), 'RVM student');
      expect(applicantSourceLabel('badabhai_worker'), 'BadaBhai worker');
      expect(applicantSourceLabel(null), isNull);
    });

    test('a row with all six keys is ON even when every value is null', () {
      final CandidateSearchRow? row = CandidateSearchRow.tryFromJson(
        <String, dynamic>{
          'workerId': 'w-1',
          'matchesFilters': true,
          'matchTier': null,
          'role': <String, dynamic>{'id': 'mskill_cnc_turner', 'label': 'CNC Turner'},
          'otherRoles': <dynamic>[],
          'skillMonths': 12,
          'industry': <String, dynamic>{'id': 'ind', 'label': 'Industry'},
          'industryMonths': null,
          'city': null,
          'tradeLevels': <dynamic>[],
          'isSample': false,
          'source': 'rvm_student',
          'firstName': null,
          'tradeLine': null,
          'expectedSalary': null,
          'machines': null,
          'area': null,
          'lastActiveOn': null,
        },
      );
      expect(row, isNotNull);
      expect(row!.hasFacts, isTrue);
      expect(row.source, 'rvm_student');
      expect(prePayFactLines(
        firstName: row.firstName,
        tradeLine: row.tradeLine,
        expectedSalary: row.expectedSalary,
        machines: row.machines,
        area: row.area,
        lastActiveOn: row.lastActiveOn,
      ).every((l) => l.$2 == kNotGiven), isTrue);
    });

    test('a feed row carries source + facts when the server sends them', () async {
      final h = _harness(<String, http.Response>{
        'GET /payer/reach/jobs/j-1/applicants': _json(<String, dynamic>{
          'jobId': '11111111-1111-4111-8111-111111111111',
          'applicants': <dynamic>[
            <String, dynamic>{
              'workerId': 'wa',
              'rank': 1,
              'score': 0.9,
              'hot': false,
              'pushEligible': false,
              'components': <dynamic>[],
              'source': 'badabhai_worker',
              'firstName': 'Aslam',
              'tradeLine': 'CNC Turner',
              'expectedSalary': '₹18,000 / month',
              'machines': <String>['VMC'],
              'area': 'Pune',
              'lastActiveOn': '2026-11-15',
            },
          ],
        }),
      });
      final List<Applicant> rows = await h.api.fetchApplicants('j-1');
      final Applicant a = rows.single;
      expect(a.source, 'badabhai_worker');
      expect(a.hasFacts, isTrue);
      expect(a.firstName, 'Aslam');
      expect(a.expectedSalary, '₹18,000 / month');
      expect(a.machines, <String>['VMC']);
      expect(a.lastActiveOn, '2026-11-15');
    });
  });

  group('what a credit opens — GET /payer/unlocks/:id/contact', () {
    const String path = 'GET /payer/unlocks/u-1/contact';

    test('404 keeps today\'s opened screen (off)', () async {
      final h = _harness(<String, http.Response>{});
      final ContactReadResult read = await h.api.readContact('u-1');
      expect(read.status, ContactReadStatus.off);
      expect(read.available, isFalse);
    });

    test('the neutral 200 body shows nothing new', () async {
      final h = _harness(<String, http.Response>{
        path: _json(<String, dynamic>{'status': 'unavailable'}),
      });
      final ContactReadResult read = await h.api.readContact('u-1');
      expect(read.status, ContactReadStatus.unavailable);
    });

    test('success carries the name (null = not given) and number', () async {
      final h = _harness(<String, http.Response>{
        path: _json(<String, dynamic>{
          'ok': true,
          'full_name': null,
          'phone': '+919876543210',
          'opened_at': '2026-11-16T10:00:00.000Z',
        }),
      });
      final ContactReadResult read = await h.api.readContact('u-1');
      expect(read.status, ContactReadStatus.contact);
      expect(read.fullName, isNull);
      expect(read.phone, '+919876543210');
      expect(factText(read.fullName), kNotGiven);
    });

    test('429 (the hourly disclosure cap) throws for the polite line', () async {
      final h = _harness(<String, http.Response>{
        path: http.Response('{}', 429),
      });
      await expectLater(
        h.api.readContact('u-1'),
        throwsA(isA<PayerApiException>()
            .having((PayerApiException e) => e.statusCode, 'statusCode', 429)),
      );
    });
  });
}

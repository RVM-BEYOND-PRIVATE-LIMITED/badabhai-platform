import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';

/// #1652 / #1666 — a payer can UNSET a job field. Both edit PATCHes
/// (`/payer/job-postings/:id`, `/payer/agency/jobs/:id`) take an optional
/// `clear: [field]` list, `.min(1)` over a CLOSED per-route enum, and 400 a
/// body that both SETS and CLEARS one field.
///
/// These pin the client half: the typed names match the server's sets, `clear`
/// rides the wire only when non-empty, a set-and-clear never leaves the device,
/// the server's own rejection comes back typed, and the mock resolves a clear
/// the way the server does (cleared → null, and set + clear refused).
class _Router {
  final List<http.Request> seen = <http.Request>[];
  http.Response Function(http.Request) respond =
      (http.Request _) => http.Response('{}', 404);

  http.Client client() => MockClient((http.Request req) async {
        seen.add(req);
        return respond(req);
      });
}

({HttpPayerApiClient api, _Router router}) _harness() {
  final _Router router = _Router();
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // ignore: discarded_futures
  tokens.save(accessToken: 'tok', payerId: 'p', role: 'company');
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

const Map<String, dynamic> _postingRow = <String, dynamic>{
  'id': _jobId,
  'roleTitle': 'CNC Setter',
  'vacancyBand': '2-5',
  'status': 'open',
};

const Map<String, dynamic> _agencyRow = <String, dynamic>{
  'id': _jobId,
  'status': 'open',
  'tradeKey': 'cnc_operator',
  'title': 'CNC Operator',
  'city': 'Pune',
  'applicantsReceived': 0,
};

/// The server's `{ error: { message, issues } }` envelope for the set-and-clear
/// refine (`ZodValidationPipe` + `AllExceptionsFilter`).
const Map<String, dynamic> _setAndClearedBody = <String, dynamic>{
  'statusCode': 400,
  'error': <String, dynamic>{
    'message': 'Validation failed',
    'issues': <Map<String, dynamic>>[
      <String, dynamic>{
        'path': 'clear',
        'message': 'a field cannot be both set and cleared in one request',
      },
    ],
  },
};

Map<String, dynamic> _sentBody(_Router router) =>
    jsonDecode(router.seen.single.body) as Map<String, dynamic>;

void main() {
  group('the typed names mirror the server sets', () {
    test('company: CLEARABLE_POSTING_FIELDS, all 14', () {
      expect(
        JobPostingClearField.values.map((JobPostingClearField f) => f.wire),
        <String>[
          'location_label',
          'description',
          'city',
          'area',
          'pay_min',
          'pay_max',
          'pay_type',
          'min_experience_years',
          'max_experience_years',
          'shift',
          'needed_by',
          'benefits',
          'requirements',
          'role_kind',
        ],
      );
    });

    test('agency: CLEARABLE_AGENCY_JOB_FIELDS, 12 — no trade, title or city',
        () {
      final List<String> wires = AgencyJobClearField.values
          .map((AgencyJobClearField f) => f.wire)
          .toList();
      expect(wires, <String>[
        'area',
        'pay_min',
        'pay_max',
        'pay_type',
        'min_experience_years',
        'max_experience_years',
        'needed_by',
        'description',
        'shift',
        'benefits',
        'requirements',
        'role_kind',
      ]);
      expect(wires, isNot(contains('city')));
      expect(wires, isNot(contains('title')));
      expect(wires, isNot(contains('trade_key')));
    });
  });

  group('HTTP — company PATCH /payer/job-postings/:id', () {
    test('clear rides as wire names; the cleared field is not in the body',
        () async {
      final h = _harness();
      h.router.respond = (http.Request _) => _json(_postingRow);

      await h.api.updateJob(
        _jobId,
        roleTitle: 'CNC Setter — Night',
        clear: const <JobPostingClearField>[
          JobPostingClearField.area,
          JobPostingClearField.locationLabel,
        ],
      );

      final Map<String, dynamic> body = _sentBody(h.router);
      expect(body['clear'], <String>['area', 'location_label']);
      expect(body['role_title'], 'CNC Setter — Night');
      expect(body.containsKey('area'), isFalse);
      expect(body.containsKey('location_label'), isFalse);
    });

    test('a clear-only edit is a legal body on its own', () async {
      final h = _harness();
      h.router.respond = (http.Request _) => _json(_postingRow);

      await h.api.updateJob(
        _jobId,
        clear: const <JobPostingClearField>[JobPostingClearField.area],
      );

      expect(_sentBody(h.router), <String, dynamic>{
        'clear': <String>['area'],
      });
    });

    test('null or empty clear sends NO key (the route 400s `clear: []`)',
        () async {
      final h = _harness();
      h.router.respond = (http.Request _) => _json(_postingRow);

      await h.api.updateJob(_jobId, roleTitle: 'A');
      await h.api.updateJob(
        _jobId,
        roleTitle: 'B',
        clear: const <JobPostingClearField>[],
      );

      for (final http.Request req in h.router.seen) {
        final Map<String, dynamic> body =
            jsonDecode(req.body) as Map<String, dynamic>;
        expect(body.containsKey('clear'), isFalse);
      }
    });

    test('a repeated name is sent once', () async {
      final h = _harness();
      h.router.respond = (http.Request _) => _json(_postingRow);

      await h.api.updateJob(
        _jobId,
        clear: const <JobPostingClearField>[
          JobPostingClearField.area,
          JobPostingClearField.area,
        ],
      );

      expect(_sentBody(h.router)['clear'], <String>['area']);
    });

    test('set AND clear of one field is refused BEFORE sending', () async {
      final h = _harness();
      h.router.respond = (http.Request _) => _json(_postingRow);

      await expectLater(
        h.api.updateJob(
          _jobId,
          area: 'Chakan',
          clear: const <JobPostingClearField>[JobPostingClearField.area],
        ),
        throwsA(
          isA<PayerApiException>()
              .having((PayerApiException e) => e.isBadRequest, '400', isTrue)
              .having(
                (PayerApiException e) => e.isSetAndCleared,
                'isSetAndCleared',
                isTrue,
              ),
        ),
      );
      expect(h.router.seen, isEmpty);
    });

    test("the server's `clear` rejection comes back typed", () async {
      final h = _harness();
      h.router.respond = (http.Request _) => _json(_setAndClearedBody, 400);

      await expectLater(
        h.api.updateJob(
          _jobId,
          clear: const <JobPostingClearField>[JobPostingClearField.area],
        ),
        throwsA(
          isA<PayerApiException>().having(
            (PayerApiException e) => e.isSetAndCleared,
            'isSetAndCleared',
            isTrue,
          ),
        ),
      );
    });

    test('any other 400 carries no code', () async {
      final h = _harness();
      h.router.respond = (http.Request _) => _json(
            <String, dynamic>{
              'statusCode': 400,
              'error': <String, dynamic>{
                'message': 'no effective changes to apply',
              },
            },
            400,
          );

      await expectLater(
        h.api.updateJob(_jobId, roleTitle: 'x'),
        throwsA(
          isA<PayerApiException>()
              .having((PayerApiException e) => e.isBadRequest, '400', isTrue)
              .having((PayerApiException e) => e.code, 'code', isNull),
        ),
      );
    });
  });

  group('HTTP — agency PATCH /payer/agency/jobs/:id', () {
    test('clear [area] rides; area is left out of the body', () async {
      final h = _harness();
      h.router.respond = (http.Request _) => _json(_agencyRow);

      await h.api.updateAgencyJob(
        _jobId,
        title: 'CNC Operator',
        city: 'Pune',
        clear: const <AgencyJobClearField>[AgencyJobClearField.area],
      );

      final Map<String, dynamic> body = _sentBody(h.router);
      expect(body['clear'], <String>['area']);
      expect(body.containsKey('area'), isFalse);
      expect(body['title'], 'CNC Operator');
    });

    test('set AND clear of one field is refused BEFORE sending', () async {
      final h = _harness();
      h.router.respond = (http.Request _) => _json(_agencyRow);

      await expectLater(
        h.api.updateAgencyJob(
          _jobId,
          area: 'Chakan',
          clear: const <AgencyJobClearField>[AgencyJobClearField.area],
        ),
        throwsA(
          isA<PayerApiException>().having(
            (PayerApiException e) => e.isSetAndCleared,
            'isSetAndCleared',
            isTrue,
          ),
        ),
      );
      expect(h.router.seen, isEmpty);
    });

    test("the server's `clear` rejection comes back typed", () async {
      final h = _harness();
      h.router.respond = (http.Request _) => _json(_setAndClearedBody, 400);

      await expectLater(
        h.api.updateAgencyJob(
          _jobId,
          clear: const <AgencyJobClearField>[AgencyJobClearField.area],
        ),
        throwsA(
          isA<PayerApiException>().having(
            (PayerApiException e) => e.isSetAndCleared,
            'isSetAndCleared',
            isTrue,
          ),
        ),
      );
    });
  });

  group('mock parity', () {
    test('company: a cleared field comes back null, the rest survive',
        () async {
      final MockPayerApiClient mock = MockPayerApiClient();

      final JobPosting row = await mock.updateJob(
        'j1',
        clear: const <JobPostingClearField>[
          JobPostingClearField.locationLabel,
        ],
      );

      expect(row.locationLabel, isNull);
      expect(row.title, 'CNC Setter');
    });

    test('company: set AND clear is refused like the real route', () async {
      final MockPayerApiClient mock = MockPayerApiClient();

      await expectLater(
        mock.updateJob(
          'j1',
          locationLabel: 'Chakan MIDC',
          clear: const <JobPostingClearField>[
            JobPostingClearField.locationLabel,
          ],
        ),
        throwsA(
          isA<PayerApiException>().having(
            (PayerApiException e) => e.isSetAndCleared,
            'isSetAndCleared',
            isTrue,
          ),
        ),
      );
    });

    test('agency: a clear-only edit removes the stored area', () async {
      final MockPayerApiClient mock = MockPayerApiClient();
      expect((await mock.getAgencyJob('mock-agency-1'))!.area, 'Chakan');

      final AgencyJobView row = await mock.updateAgencyJob(
        'mock-agency-1',
        clear: const <AgencyJobClearField>[AgencyJobClearField.area],
      );

      expect(row.area, isNull);
      expect(row.city, 'Pune');
      expect((await mock.getAgencyJob('mock-agency-1'))!.area, isNull);
    });

    test('agency: set AND clear is refused and nothing is stored', () async {
      final MockPayerApiClient mock = MockPayerApiClient();

      await expectLater(
        mock.updateAgencyJob(
          'mock-agency-1',
          area: 'Talegaon',
          clear: const <AgencyJobClearField>[AgencyJobClearField.area],
        ),
        throwsA(
          isA<PayerApiException>().having(
            (PayerApiException e) => e.isSetAndCleared,
            'isSetAndCleared',
            isTrue,
          ),
        ),
      );
      expect((await mock.getAgencyJob('mock-agency-1'))!.area, 'Chakan');
    });
  });
}

import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:payer_app/core/auth/payer_http.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/http_payer_api_client.dart';
import 'package:payer_app/core/data/models.dart';

/// #2595 (M7) — a refused job WRITE names every field it refused.
///
/// Both create routes (`POST /payer/job-postings`, `POST /payer/agency/jobs`)
/// validate through `ZodValidationPipe`, whose 400 the global filter wraps as
/// `{ error: { message: 'Validation failed', issues: [{ path, message }] } }`.
/// The worker-visible text screen (`screenWorkerVisibleText`) refuses a phone
/// number, a company name or a link there — the device mirrors only the phone
/// and email shapes, so those 400s reach the Post form. The creates used to
/// throw a bare status, so the form could only toast "the server rejected
/// these details"; every write now carries each issue by its field
/// ([PayerApiException.fieldErrors]) for the form to show AT its box.
http.Response _json(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status,
        headers: <String, String>{'content-type': 'application/json'});

/// The validation 400 for [issues], as the API sends it.
http.Response _refused(List<Map<String, String>> issues) => _json(
      <String, dynamic>{
        'statusCode': 400,
        'error': <String, dynamic>{
          'message': 'Validation failed',
          'issues': issues,
        },
      },
      400,
    );

HttpPayerApiClient _api(http.Response response) {
  final PayerTokenStore tokens = PayerTokenStore(InMemoryKeyValueStore());
  // ignore: discarded_futures
  tokens.save(accessToken: 'tok', payerId: 'p', role: 'company');
  return HttpPayerApiClient(PayerHttp(
    baseUrl: 'http://api.test',
    tokenStore: tokens,
    client: MockClient((http.Request _) async => response),
  ));
}

Future<PayerApiException> _companyCreateFailure(http.Response response) async {
  try {
    await _api(response).createCompanyJob(
      orgLabel: 'Acme',
      roleTitle: 'CNC Setter',
      vacancyBand: '2-5',
    );
  } on PayerApiException catch (e) {
    return e;
  }
  fail('the create did not throw');
}

Future<PayerApiException> _agencyCreateFailure(http.Response response) async {
  try {
    await _api(response).createAgencyJob(
      tradeKey: 'cnc_operator',
      title: 'CNC Operator',
      city: 'Pune',
    );
  } on PayerApiException catch (e) {
    return e;
  }
  fail('the create did not throw');
}

const String _jobId = '22222222-2222-4222-8222-222222222222';

void main() {
  group('company create — POST /payer/job-postings', () {
    test('every issue comes back by its field, phrased to sit at it', () async {
      final PayerApiException e = await _companyCreateFailure(_refused(
        <Map<String, String>>[
          <String, String>{
            'path': 'role_title',
            'message': 'title must not contain a company name',
          },
          <String, String>{
            'path': 'description',
            'message': 'description must not contain links',
          },
          <String, String>{
            'path': 'benefits.2',
            'message': 'remove contact details from benefits',
          },
          <String, String>{
            'path': 'area',
            'message': 'area must not contain a company name',
          },
        ],
      ));

      expect(e.isBadRequest, isTrue);
      expect(e.fieldErrors, <String, String>{
        'role_title': 'Title must not contain a company name.',
        'description': 'Must not contain links.',
        'benefits': 'Remove contact details from benefits.',
        'area': 'Must not contain a company name.',
      });
      // The first issue still rides as the one-line, field-named message.
      expect(e.validationMessage, 'Title must not contain a company name');
    });

    test('the first issue on a field wins', () async {
      final PayerApiException e = await _companyCreateFailure(_refused(
        <Map<String, String>>[
          <String, String>{
            'path': 'description',
            'message': 'description must not contain a company name',
          },
          <String, String>{
            'path': 'description',
            'message': 'description must not contain links',
          },
        ],
      ));
      expect(e.fieldErrors, <String, String>{
        'description': 'Must not contain a company name.',
      });
    });

    test("Zod's length ceiling reads as plain words", () async {
      final PayerApiException e = await _companyCreateFailure(_refused(
        <Map<String, String>>[
          <String, String>{
            'path': 'role_title',
            'message': 'Too big: expected string to have <=200 characters',
          },
        ],
      ));
      expect(e.fieldErrors, <String, String>{
        'role_title': 'Must be 200 characters or fewer.',
      });
    });

    test('a 400 that names no field carries none', () async {
      // A service-thrown 400 is a bare message, not a field issue.
      final PayerApiException e = await _companyCreateFailure(_json(
        <String, dynamic>{
          'statusCode': 400,
          'error': <String, dynamic>{
            'message': 'a posting may name at most 3 skills (got 4)',
          },
        },
        400,
      ));
      expect(e.fieldErrors, isEmpty);
      expect(
        e.validationMessage,
        'A posting may name at most 3 skills (got 4).',
      );
    });

    test('a non-400 stays a bare status', () async {
      final PayerApiException e = await _companyCreateFailure(_json(
        <String, dynamic>{
          'statusCode': 503,
          'error': <String, dynamic>{'message': 'Service unavailable'},
        },
        503,
      ));
      expect(e.statusCode, 503);
      expect(e.fieldErrors, isEmpty);
      expect(e.validationMessage, isNull);
    });
  });

  group('agency create — POST /payer/agency/jobs', () {
    test('every issue comes back by its field', () async {
      final PayerApiException e = await _agencyCreateFailure(_refused(
        <Map<String, String>>[
          <String, String>{
            'path': 'title',
            'message': 'title must not contain links',
          },
          <String, String>{
            'path': 'city',
            'message': 'remove contact details from the city',
          },
        ],
      ));
      expect(e.fieldErrors, <String, String>{
        'title': 'Must not contain links.',
        'city': 'Remove contact details from the city.',
      });
      expect(e.validationMessage, 'Job title: Must not contain links.');
    });
  });

  group('the edits carry them too', () {
    test('company PATCH', () async {
      PayerApiException? e;
      try {
        await _api(_refused(<Map<String, String>>[
          <String, String>{
            'path': 'requirements.0',
            'message': 'requirements must not contain a company name',
          },
        ])).updateJob(_jobId, requirements: const <String>['Tata Pvt Ltd']);
      } on PayerApiException catch (caught) {
        e = caught;
      }
      expect(e!.fieldErrors, <String, String>{
        'requirements': 'Must not contain a company name.',
      });
    });

    test('agency PATCH', () async {
      PayerApiException? e;
      try {
        await _api(_refused(<Map<String, String>>[
          <String, String>{
            'path': 'area',
            'message': 'area must not contain links',
          },
        ])).updateAgencyJob(_jobId, area: 'x');
      } on PayerApiException catch (caught) {
        e = caught;
      }
      expect(e!.fieldErrors, <String, String>{
        'area': 'Must not contain links.',
      });
    });
  });
}

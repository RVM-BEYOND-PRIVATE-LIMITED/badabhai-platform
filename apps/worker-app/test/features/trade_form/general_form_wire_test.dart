import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/data/trade_form_repository_impl.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';

/// ADR-0045 §3.3/§3.4 — THE GENERAL ROAD'S WIRE.
///
/// The general form rides the trade form's envelope, so the risk is not that it
/// fails to parse — it already did — but that the INSTRUCTIONS its marker
/// screens carry are silently dropped. They were: `_parseStep` kept only
/// `tier_scope` and `suggested_certificates`, so `fields`, `require_start_ym`,
/// `lists` and `education_options` never reached the app, and the pages had no
/// way to know what they had been asked for.
SessionRepository _signedIn() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

/// The issue's own example body for a fresh worker.
Map<String, dynamic> _generalFormJson() => <String, dynamic>{
      'session_id': '8f14e45f-ceea-467a-9575-2f1c3b1f3a1e',
      'role_label': 'Lab Chemist',
      'complete': false,
      'sections': <dynamic>[
        <String, dynamic>{
          'id': 'terms',
          'title': 'Availability & terms',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'preferences',
              'endpoint': 'PUT /workers/me/work-preferences',
              'fields': <String>[
                'salary_expected_min',
                'salary_expected_max',
                'preferred_cities',
                'shift',
                'work_types',
                'languages',
                'availability',
              ],
            },
          ],
        },
        <String, dynamic>{
          'id': 'work_history',
          'title': 'Work history',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'question',
              'question': <String, dynamic>{
                'question_key': 'has_work_history',
                'prompt_text': 'Kya aapne pehle kahin kaam kiya hai?',
                'why_text': null,
                'answer_type': 'boolean',
                'options': <dynamic>[],
              },
              'ui': <String, dynamic>{'searchable': false},
              'answer': null,
              'suggestion': null,
            },
            <String, dynamic>{
              'type': 'employment',
              'endpoint': 'PUT /workers/me/employment',
              'require_start_ym': true,
            },
          ],
        },
        <String, dynamic>{
          'id': 'education',
          'title': 'Education',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'qualifications',
              'endpoint': 'PUT /workers/me/qualifications',
              'suggested_certificates': <dynamic>[],
              'lists': <String>['educations'],
              'education_options': <dynamic>[
                <String, dynamic>{'key': 'below_10', 'label': 'Below 10th'},
                <String, dynamic>{'key': 'class_10', 'label': '10th pass'},
                <String, dynamic>{'key': 'iti', 'label': 'ITI'},
                <String, dynamic>{'key': 'postgraduate', 'label': 'Postgraduate'},
              ],
            },
          ],
        },
        <String, dynamic>{
          'id': 'certifications',
          'title': 'Certificates & training',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'qualifications',
              'endpoint': 'PUT /workers/me/qualifications',
              'suggested_certificates': <dynamic>[],
              'lists': <String>['certificates', 'trainings'],
            },
          ],
        },
        <String, dynamic>{
          'id': 'brief',
          'title': 'Aapke baare mein',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'question',
              'question': <String, dynamic>{
                'question_key': 'profile_brief',
                'prompt_text': 'Apne kaam ke baare mein 1-2 line batayein',
                'why_text': 'Ye aapke resume mein sabse upar dikhega.',
                'answer_type': 'text',
                'options': <dynamic>[],
              },
              'ui': <String, dynamic>{'searchable': false},
              'answer': null,
              'suggestion': null,
            },
          ],
        },
      ],
    };

TradeFormRepositoryImpl _repo(
  Object body,
  int status, {
  void Function(http.Request)? onRequest,
}) =>
    TradeFormRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          onRequest?.call(req);
          return http.Response(
            jsonEncode(body),
            status,
            headers: <String, String>{
              'content-type': 'application/json; charset=utf-8',
            },
          );
        }),
      ),
      _signedIn(),
    );

void main() {
  group('GET /profiling/general-form', () {
    test('the issue\'s example body parses whole', () async {
      late http.Request captured;
      final GeneralForm form = (await _repo(
        _generalFormJson(),
        200,
        onRequest: (http.Request r) => captured = r,
      ).loadGeneralForm())!;

      expect(captured.method, 'GET');
      expect(captured.url.path, '/profiling/general-form');
      expect(captured.headers['authorization'], 'Bearer tok');

      expect(form.sessionId, '8f14e45f-ceea-467a-9575-2f1c3b1f3a1e');
      expect(form.roleLabel, 'Lab Chemist');
      expect(form.complete, isFalse);
      expect(form.sections.map((TradeFormSection s) => s.id).toList(),
          <String>['terms', 'work_history', 'education', 'certifications', 'brief']);
      // The titles are used VERBATIM — the app never composes them.
      expect(form.sections.first.title, 'Availability & terms');
      expect(form.sections.last.title, 'Aapke baare mein');
      expect(form.steps, hasLength(6));
    });

    test('the terms screen carries its ask list — the gap that hid #1793',
        () async {
      final GeneralForm form = (await _repo(_generalFormJson(), 200).loadGeneralForm())!;
      final TradeFormPreferencesStep terms =
          form.sections.first.screens.single as TradeFormPreferencesStep;

      expect(terms.fields, contains('salary_expected_min'));
      expect(terms.fields, contains('salary_expected_max'));
      expect(terms.fields, contains('work_types'));
      expect(terms.asks('availability'), isTrue);
      expect(terms.asks('documents_ready'), isFalse,
          reason: 'a field the server did not ask for must not be shown');
    });

    test('employment carries require_start_ym — the gap that hid #1794',
        () async {
      final GeneralForm form = (await _repo(_generalFormJson(), 200).loadGeneralForm())!;
      final TradeFormEmploymentStep work = form.sections[1].screens.last
          as TradeFormEmploymentStep;
      expect(work.requireStartYm, isTrue);
    });

    test('the two qualifications screens own DIFFERENT lists', () async {
      final GeneralForm form = (await _repo(_generalFormJson(), 200).loadGeneralForm())!;
      final TradeFormQualificationsStep education =
          form.sections[2].screens.single as TradeFormQualificationsStep;
      final TradeFormQualificationsStep certs =
          form.sections[3].screens.single as TradeFormQualificationsStep;

      // Without this split each screen would overwrite the other's work.
      expect(education.lists, <String>['educations']);
      expect(education.owns('educations'), isTrue);
      expect(education.owns('certificates'), isFalse);
      expect(certs.lists, <String>['certificates', 'trainings']);
      expect(certs.owns('educations'), isFalse);

      // And the eight levels arrive as key+label pairs, so a stored
      // `postgraduate` has a label to render instead of a raw token.
      expect(education.educationOptions, hasLength(4));
      expect(education.educationOptions.first.key, 'below_10');
      expect(education.educationOptions.first.label, 'Below 10th');
      expect(
        education.educationOptions
            .firstWhere((TradeFormLabelledOption o) => o.key == 'postgraduate')
            .label,
        'Postgraduate',
      );
    });

    test('404 is "nothing to fill" — null, never a Failure', () async {
      expect(
        await _repo(<String, dynamic>{'statusCode': 404}, 404).loadGeneralForm(),
        isNull,
      );
    });

    test('any other failure PROPAGATES — a handed form that will not load '
        'must be said, not shown empty', () {
      expect(_repo(<String, dynamic>{}, 500).loadGeneralForm(),
          throwsA(isA<Failure>()));
    });

    test('no session_id → null: the mic and the finish both address it',
        () async {
      final Map<String, dynamic> body = _generalFormJson()..remove('session_id');
      expect(await _repo(body, 200).loadGeneralForm(), isNull);
    });

    test('an unknown screen type is DROPPED, never fatal to the form',
        () async {
      final Map<String, dynamic> body = _generalFormJson();
      (body['sections'] as List<dynamic>).add(<String, dynamic>{
        'id': 'future',
        'title': 'Something this build has never heard of',
        'screens': <dynamic>[
          <String, dynamic>{'type': 'hologram'},
        ],
      });
      final GeneralForm form = (await _repo(body, 200).loadGeneralForm())!;
      expect(form.sections, hasLength(6));
      expect(form.sections.last.screens, isEmpty);
      expect(form.steps, hasLength(6), reason: 'the rest of the form survives');
    });

    test('a malformed education option is dropped, not half-rendered', () async {
      final Map<String, dynamic> body = _generalFormJson();
      final Map<String, dynamic> edu = ((body['sections'] as List<dynamic>)[2]
          as Map<String, dynamic>)['screens'][0] as Map<String, dynamic>;
      edu['education_options'] = <dynamic>[
        <String, dynamic>{'key': 'iti', 'label': 'ITI'},
        <String, dynamic>{'key': 'no_label'},
        <String, dynamic>{'label': 'No key'},
        <String, dynamic>{'key': '  ', 'label': 'blank key'},
        'not a map',
      ];
      final GeneralForm form = (await _repo(body, 200).loadGeneralForm())!;
      final TradeFormQualificationsStep education =
          form.sections[2].screens.single as TradeFormQualificationsStep;
      expect(education.educationOptions, hasLength(1));
      expect(education.educationOptions.single.key, 'iti');
    });
  });

  group('POST /profiling/general-form/answer', () {
    test('posts the question and reads complete + schema_stale', () async {
      late http.Request captured;
      final TradeFormAnswerResult r = await _repo(
        <String, dynamic>{
          'question_key': 'profile_brief',
          'status': 'answered',
          'complete': true,
          'schema_stale': false,
        },
        200,
        onRequest: (http.Request req) => captured = req,
      ).submitGeneralAnswer(
        questionKey: 'profile_brief',
        answer: const TradeFormAnswer.text('Lab chemist, 4 saal.'),
      );

      expect(captured.url.path, '/profiling/general-form/answer');
      final Map<String, dynamic> body =
          jsonDecode(captured.body) as Map<String, dynamic>;
      expect(body['question_key'], 'profile_brief');
      expect(r.status, TradeFormAnswerStatus.answered);
      // The general route sends NO counters, so `complete` is the only finish
      // signal there is.
      expect(r.complete, isTrue);
      expect(r.answered, 0);
      expect(r.total, 0);
    });

    test('schema_stale says the walk must be rebuilt', () async {
      final TradeFormAnswerResult r = await _repo(
        <String, dynamic>{
          'question_key': 'has_work_history',
          'status': 'answered',
          'complete': false,
          'schema_stale': true,
        },
        200,
      ).submitGeneralAnswer(
        questionKey: 'has_work_history',
        answer: const TradeFormAnswer.boolean(false),
      );
      expect(r.schemaStale, isTrue);
      expect(r.complete, isFalse);
    });

    test('a 400 is surfaced with the server\'s own message', () {
      expect(
        _repo(<String, dynamic>{'message': 'unknown question_key'}, 400)
            .submitGeneralAnswer(
          questionKey: 'nope',
          answer: const TradeFormAnswer.boolean(true),
        ),
        throwsA(isA<InvalidRequestFailure>()),
      );
    });
  });

  group('the trade form is untouched', () {
    test('its marker screens still default to today behaviour', () {
      // Every general-road key is ABSENT on a trade-form screen, so each default
      // must be what that form has always done.
      const TradeFormPreferencesStep prefs = TradeFormPreferencesStep();
      expect(prefs.fields, isEmpty);
      expect(prefs.asks('anything'), isTrue, reason: 'empty asks everything');

      const TradeFormEmploymentStep work = TradeFormEmploymentStep();
      expect(work.requireStartYm, isFalse);

      const TradeFormQualificationsStep quals = TradeFormQualificationsStep();
      expect(quals.lists, isEmpty);
      expect(quals.owns('certificates'), isTrue, reason: 'empty owns them all');
      expect(quals.educationOptions, isEmpty);
    });
  });
}

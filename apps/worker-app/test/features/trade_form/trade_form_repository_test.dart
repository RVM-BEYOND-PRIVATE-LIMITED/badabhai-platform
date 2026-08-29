import 'dart:convert';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/data/trade_form_repository_impl.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

SessionRepository _session() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

/// A form with one of every screen type: an ANSWERED non-searchable
/// multi-select, an UNANSWERED searchable multi-select, an unanswered `text`
/// question, then both markers.
Map<String, dynamic> _formJson() => <String, dynamic>{
      'kind': 'cnc_turner',
      'pack_id': 'qp_cnc_turning',
      'pack_version': 1,
      'sections': <dynamic>[
        <String, dynamic>{
          'id': 'capability',
          'title': 'Machines, controllers & capability',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'question',
              'question': <String, dynamic>{
                'question_key': 'turning_machine',
                'prompt_text': 'Aap kaunsi turning machine chalate hain?',
                'why_text': 'Machine ke hisaab se sahi kaam dikhaya jaata hai.',
                'answer_type': 'multi_select',
                'options': <dynamic>[
                  <String, dynamic>{
                    'option_key': 'cnc_lathe',
                    'label_text': 'CNC lathe',
                    'is_none_of_above': false,
                  },
                ],
              },
              'ui': <String, dynamic>{'searchable': false},
              'answer': <String, dynamic>{
                'status': 'answered',
                'option_keys': <String>['cnc_lathe'],
                'text': null,
                'number': null,
                'bool': null,
              },
            },
            <String, dynamic>{
              'type': 'question',
              'question': <String, dynamic>{
                'question_key': 'material_worked',
                'prompt_text': 'Aap kaunsi dhaatu par kaam karte hain?',
                'why_text': null,
                'answer_type': 'multi_select',
                'options': <dynamic>[
                  <String, dynamic>{
                    'option_key': 'mild_steel',
                    'label_text': 'Mild steel',
                    'is_none_of_above': false,
                  },
                ],
              },
              'ui': <String, dynamic>{'searchable': true},
              'answer': null,
            },
          ],
        },
        const <String, dynamic>{
          'id': 'terms',
          'title': 'Availability & terms',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'preferences',
              'endpoint': 'PUT /workers/me/work-preferences',
            },
          ],
        },
        const <String, dynamic>{
          'id': 'work_history',
          'title': 'Work history',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'employment',
              'endpoint': 'PUT /workers/me/employment',
            },
          ],
        },
        <String, dynamic>{
          'id': 'qualifications',
          'title': 'Qualification, documents & languages',
          'screens': <dynamic>[
            <String, dynamic>{
              'type': 'question',
              'question': <String, dynamic>{
                'question_key': 'iti_project_work',
                'prompt_text': 'ITI me kya banaya tha?',
                'why_text': null,
                'answer_type': 'text',
                'options': <dynamic>[],
              },
              'ui': <String, dynamic>{'searchable': false},
              'answer': null,
            },
          ],
        },
      ],
    };

void main() {
  group('TradeFormRepositoryImpl.loadForm', () {
    test('parses every screen type + the answered/unanswered distinction',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          expect(req.url.path, '/profiling/form');
          return http.Response(jsonEncode(_formJson()), 200);
        }),
      );
      final TradeFormRepositoryImpl repo = TradeFormRepositoryImpl(api, _session());

      final TradeForm? form = await repo.loadForm();

      expect(form, isNotNull);
      expect(form!.kind, 'cnc_turner');
      expect(form.packId, 'qp_cnc_turning');
      expect(form.sections, hasLength(4));
      expect(form.questionSteps, hasLength(3)); // 2 in capability + 1 in qualifications

      final TradeFormQuestionStep answered =
          form.sections[0].screens[0] as TradeFormQuestionStep;
      expect(answered.question.id, 'turning_machine');
      expect(answered.searchable, isFalse);
      expect(answered.isAnswered, isTrue);
      expect(answered.answer!.status, TradeFormAnswerStatus.answered);
      expect(answered.answer!.optionKeys, <String>['cnc_lathe']);

      final TradeFormQuestionStep unanswered =
          form.sections[0].screens[1] as TradeFormQuestionStep;
      expect(unanswered.searchable, isTrue);
      expect(unanswered.isAnswered, isFalse);
      expect(unanswered.answer, isNull);

      expect(form.sections[1].screens.single, isA<TradeFormPreferencesStep>());
      expect(form.sections[2].screens.single, isA<TradeFormEmploymentStep>());

      final TradeFormQuestionStep openQ =
          form.sections[3].screens.single as TradeFormQuestionStep;
      expect(openQ.question.kind, VoiceQuestionKind.open);
    });

    test('a declined answer is NOT confused with an unanswered one', () async {
      final Map<String, dynamic> json = _formJson();
      (((json['sections'] as List<dynamic>)[0] as Map<String, dynamic>)['screens']
          as List<dynamic>)[1] = <String, dynamic>{
        'type': 'question',
        'question': <String, dynamic>{
          'question_key': 'material_worked',
          'prompt_text': 'Aap kaunsi dhaatu par kaam karte hain?',
          'why_text': null,
          'answer_type': 'multi_select',
          'options': <dynamic>[],
        },
        'ui': <String, dynamic>{'searchable': true},
        'answer': <String, dynamic>{
          'status': 'declined',
          'option_keys': <String>[],
          'text': null,
          'number': null,
          'bool': null,
        },
      };
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient(
            (http.Request req) async => http.Response(jsonEncode(json), 200)),
      );
      final TradeFormRepositoryImpl repo = TradeFormRepositoryImpl(api, _session());

      final TradeForm? form = await repo.loadForm();

      final TradeFormQuestionStep declined =
          form!.sections[0].screens[1] as TradeFormQuestionStep;
      expect(declined.isAnswered, isTrue); // a settled answer, not a gap
      expect(declined.answer!.isDeclined, isTrue);
    });

    test('404 (never handed a form) returns null, not an empty form', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{'message': 'not found'}), 404)),
      );
      final TradeFormRepositoryImpl repo = TradeFormRepositoryImpl(api, _session());

      expect(await repo.loadForm(), isNull);
    });

    test('a real server/network failure still throws', () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response('', 500)),
      );
      final TradeFormRepositoryImpl repo = TradeFormRepositoryImpl(api, _session());

      expect(repo.loadForm(), throwsA(isA<Failure>()));
    });
  });

  group('TradeFormRepositoryImpl.submitAnswer', () {
    test('chips/text/boolean/declined all POST the discriminated wire shape',
        () async {
      final List<Map<String, dynamic>> bodies = <Map<String, dynamic>>[];
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          bodies.add(jsonDecode(req.body) as Map<String, dynamic>);
          return http.Response(
            jsonEncode(<String, dynamic>{
              'question_key': bodies.last['question_key'],
              'status': 'answered',
              'answered': bodies.length,
              'total': 4,
            }),
            200,
          );
        }),
      );
      final TradeFormRepositoryImpl repo = TradeFormRepositoryImpl(api, _session());

      await repo.submitAnswer(
        questionKey: 'turning_machine',
        answer: const TradeFormAnswer.chips(<String>['cnc_lathe']),
      );
      await repo.submitAnswer(
        questionKey: 'iti_project_work',
        answer: const TradeFormAnswer.text('Bush banaya tha'),
      );
      await repo.submitAnswer(
        questionKey: 'drawing_reading',
        answer: const TradeFormAnswer.boolean(true),
      );
      final TradeFormAnswerResult declined = await repo.submitAnswer(
        questionKey: 'material_worked',
        answer: const TradeFormAnswer.declined(),
      );

      expect(bodies[0]['answer'],
          <String, dynamic>{'kind': 'chips', 'option_keys': <String>['cnc_lathe']});
      expect(bodies[1]['answer'],
          <String, dynamic>{'kind': 'text', 'text': 'Bush banaya tha'});
      expect(bodies[2]['answer'], <String, dynamic>{'kind': 'boolean', 'value': true});
      expect(bodies[3]['answer'], <String, dynamic>{'kind': 'declined'});
      expect(declined.answered, 4);
      expect(declined.total, 4);
    });

    test('a 400 naming an unknown option_key surfaces the server message',
        () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{
              'message': 'unknown option keys: not_a_real_key',
            }),
            400)),
      );
      final TradeFormRepositoryImpl repo = TradeFormRepositoryImpl(api, _session());

      await expectLater(
        repo.submitAnswer(
          questionKey: 'turning_machine',
          answer: const TradeFormAnswer.chips(<String>['not_a_real_key']),
        ),
        throwsA(isA<InvalidRequestFailure>().having(
          (InvalidRequestFailure f) => f.message,
          'message',
          contains('not_a_real_key'),
        )),
      );
    });
  });
}

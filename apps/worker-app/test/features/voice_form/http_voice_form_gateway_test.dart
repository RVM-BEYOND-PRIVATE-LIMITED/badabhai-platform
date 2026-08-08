import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/voice_form/data/http_voice_form_gateway.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';

SessionRepository _session() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
  ..setSession('unused-chat-id');

Map<String, dynamic> _questionStep({
  String key = 'q_material',
  String type = 'single_select',
  int index = 4,
  int total = 11,
}) =>
    <String, dynamic>{
      'kind': 'question',
      'index': index,
      'total': total,
      'question': <String, dynamic>{
        'question_key': key,
        'prompt_text': 'Kaunsa material?',
        'answer_type': type,
        'options': <dynamic>[
          <String, dynamic>{'option_key': 'mild_steel', 'label_text': 'Mild steel'},
          <String, dynamic>{'option_key': 'stainless', 'label_text': 'Stainless'},
        ],
        'why_text': 'Isse sahi kaam milta hai.',
        'tts_clip_id': 'a1b2c3d4e5f6a7b8',
      },
    };

void main() {
  test('start() parses a question step into a typed NextQuestion (#699)',
      () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{
              'session_id': 's1',
              'step': _questionStep(),
            }),
            201,
          )),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());

    final VoiceFormStep step = await gw.start();
    expect(step, isA<NextQuestion>());
    final NextQuestion q = step as NextQuestion;
    expect(q.index, 4);
    expect(q.total, 11);
    expect(q.question.id, 'q_material');
    expect(q.question.kind, VoiceQuestionKind.singleSelect);
    expect(q.question.options.map((VoiceChoice c) => c.key),
        <String>['mild_steel', 'stainless']);
    expect(q.question.whyText, 'Isse sahi kaam milta hai.');
    expect(q.question.ttsAssetKey, 'a1b2c3d4e5f6a7b8');
  });

  test('submit(chips) POSTs kind:chips with option_keys (never labels) (#699)',
      () async {
    late Map<String, dynamic> answerBody;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') {
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep()}),
              201);
        }
        // /profiling/answer
        answerBody = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
            jsonEncode(<String, dynamic>{'step': <String, dynamic>{'kind': 'done'}}),
            201);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start(); // learns session_id + question_key

    final VoiceFormStep step =
        await gw.submit(const VoiceAnswer.chips(<String>['mild_steel', 'stainless']));

    expect(step, isA<VoiceFormDone>());
    expect(answerBody['session_id'], 's1');
    expect(answerBody['question_key'], 'q_material');
    expect(answerBody['answer'],
        <String, dynamic>{'kind': 'chips', 'option_keys': ['mild_steel', 'stainless']});
  });

  test('a 409 on submit re-attaches and redraws the current step, never retries '
      'the same body (#699)', () async {
    final List<String> hits = <String>[];
    int answerCalls = 0;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        hits.add(req.url.path);
        if (req.url.path == '/profiling/session') {
          // first call = start(); the reattach after 409 = second call.
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep(key: 'q_now')}),
              201);
        }
        answerCalls++;
        return http.Response('{"message":"stale"}', 409); // engine moved on
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    final VoiceFormStep step =
        await gw.submit(const VoiceAnswer.text('main welder hoon'));

    expect(step, isA<NextQuestion>());
    expect((step as NextQuestion).question.id, 'q_now',
        reason: 're-read gives the CURRENT question');
    expect(answerCalls, 1, reason: 'the same answer body is never re-POSTed');
    // start (initial) + answer(409) + session (reattach).
    expect(hits, <String>['/profiling/session', '/profiling/answer', '/profiling/session']);
  });

  test('an "unavailable" step surfaces a retryable VoiceUnavailableFailure — '
      'never dead-lettered (#699)', () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') {
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep()}),
              201);
        }
        return http.Response(
            jsonEncode(<String, dynamic>{
              'step': <String, dynamic>{'kind': 'unavailable', 'reply': 'Thodi der baad koshish karein.'}
            }),
            201);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    await expectLater(
      gw.submit(const VoiceAnswer.boolean(true)),
      throwsA(isA<VoiceUnavailableFailure>()),
    );
  });

  test('finalize() is OK on committed:true and retryable on committed:false (#699)',
      () async {
    bool commit = true;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') {
          return http.Response(
              jsonEncode(<String, dynamic>{'session_id': 's1', 'step': _questionStep()}),
              201);
        }
        return http.Response(
            jsonEncode(<String, dynamic>{'session_id': 's1', 'committed': commit}),
            201);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    await gw.finalize(); // committed:true → no throw

    commit = false;
    await expectLater(gw.finalize(), throwsA(isA<VoiceUnavailableFailure>()));
  });

  test('no session token fails closed with UnauthorizedFailure (#699)', () {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((_) async => http.Response('{}', 200)),
    );
    final HttpVoiceFormGateway gw =
        HttpVoiceFormGateway(api, SessionRepository());
    expect(gw.start(), throwsA(isA<UnauthorizedFailure>()));
  });
}

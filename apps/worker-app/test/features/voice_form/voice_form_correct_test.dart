import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/voice_form/data/http_voice_form_gateway.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_correction_outcome.dart';
import 'package:badabhai_worker_app/features/voice_form/domain/voice_form_models.dart';

SessionRepository _session() =>
    SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

/// A start() response that just settles the session id (step is done — the
/// correction path does not care what the interview is on).
http.Response _startDone() => http.Response(
  jsonEncode(<String, dynamic>{
    'session_id': 's1',
    'step': <String, dynamic>{'kind': 'done'},
  }),
  201,
);

/// #700 — the client half of the review-screen correction: gateway.correct()
/// against POST /profiling/correct.
void main() {
  test(
    'correct() posts the answer and parses the row + rebuild flag',
    () async {
      late String path;
      late Map<String, dynamic> body;
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          if (req.url.path == '/profiling/session') return _startDone();
          path = req.url.path;
          body = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'session_id': 's1',
              'question_key': 'q_city',
              'row': <String, dynamic>{
                'question_key': 'q_city',
                'prompt_text': 'City?',
                'status': 'answered',
                'display_value': 'Pune',
              },
              'correction_count': 2,
              'profile_rebuild_required': true,
            }),
            200,
          );
        }),
      );
      final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
      await gw.start();

      final VoiceCorrectionOutcome outcome = await gw.correct(
        const VoiceAnswer.text('Pune'),
        questionKey: 'q_city',
      );

      expect(path, '/profiling/correct');
      expect(body['session_id'], 's1');
      expect(body['question_key'], 'q_city');
      expect(body['answer'], <String, dynamic>{'kind': 'text', 'text': 'Pune'});
      expect(outcome.questionId, 'q_city');
      expect(outcome.displayValue, 'Pune');
      expect(outcome.declined, isFalse);
      expect(outcome.correctionCount, 2);
      expect(outcome.profileRebuildRequired, isTrue);
    },
  );

  test('a declined correction sets declined + a null value', () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') return _startDone();
        return http.Response(
          jsonEncode(<String, dynamic>{
            'session_id': 's1',
            'question_key': 'q_x',
            'row': <String, dynamic>{
              'question_key': 'q_x',
              'prompt_text': 'X?',
              'status': 'declined',
              'display_value': null,
            },
            'correction_count': 1,
            'profile_rebuild_required': false,
          }),
          200,
        );
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    final VoiceCorrectionOutcome o = await gw.correct(
      const VoiceAnswer.text('nahi pata'),
      questionKey: 'q_x',
    );
    expect(o.declined, isTrue);
    expect(o.displayValue, isNull);
    expect(o.profileRebuildRequired, isFalse);
  });

  test('a spoken correction carries the registered voice_note_id', () async {
    late Map<String, dynamic> body;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') return _startDone();
        body = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode(<String, dynamic>{
            'session_id': 's1',
            'question_key': 'q_city',
            'row': <String, dynamic>{
              'question_key': 'q_city',
              'prompt_text': 'City?',
              'status': 'answered',
              'display_value': 'Mumbai',
            },
            'correction_count': 1,
            'profile_rebuild_required': false,
          }),
          200,
        );
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    await gw.correct(const VoiceAnswer.spoken('vn-9'), questionKey: 'q_city');
    expect(body['answer'], <String, dynamic>{
      'kind': 'spoken',
      'voice_note_id': 'vn-9',
    });
  });

  test('a 409 (the question is still on screen) fails closed', () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/profiling/session') return _startDone();
        return http.Response('{"message":"still on screen"}', 409);
      }),
    );
    final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
    await gw.start();

    await expectLater(
      gw.correct(const VoiceAnswer.text('x'), questionKey: 'q_x'),
      throwsA(isA<Failure>()),
    );
  });

  test(
    'correct() before start() is Unauthorized — no session to attach to',
    () async {
      final ApiClient api = ApiClient(
        baseUrl: 'http://test',
        client: MockClient(
          (http.Request req) async => http.Response('{}', 200),
        ),
      );
      final HttpVoiceFormGateway gw = HttpVoiceFormGateway(api, _session());
      await expectLater(
        gw.correct(const VoiceAnswer.text('x'), questionKey: 'q_x'),
        throwsA(isA<UnauthorizedFailure>()),
      );
    },
  );
}

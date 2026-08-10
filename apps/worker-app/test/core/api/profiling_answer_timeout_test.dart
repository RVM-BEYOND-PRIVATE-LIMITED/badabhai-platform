import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// The spoken-answer timeout fix: POST /profiling/answer transcribes the clip
/// IN-REQUEST server-side (Sarvam STT, up to the ~140s TD59 ceiling), so this
/// one route must wait out [kVoiceTranscriptWaitBudget] (150s) — while every
/// other endpoint keeps the 15s [kRequestTimeout]. A stalled server is simulated
/// with a virtual clock so the assertion is instant, not a real 90s wait.
void main() {
  // A server that answers only after [delay] of (virtual) processing.
  ApiClient apiThatRespondsAfter(Duration delay, {int status = 200}) => ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          await Future<void>.delayed(delay);
          return http.Response(
              jsonEncode(
                  <String, dynamic>{'step': <String, dynamic>{'kind': 'done'}}),
              status);
        }),
      );

  final Map<String, dynamic> body = <String, dynamic>{
    'session_id': 's1',
    'question_key': 'q1',
    'answer': <String, dynamic>{'kind': 'text', 'text': 'x'},
  };

  group('/profiling/answer long timeout (spoken-answer STT)', () {
    test('survives a server that takes 90s — past 15s, within the 150s budget',
        () {
      fakeAsync((FakeAsync async) {
        final ApiClient api = apiThatRespondsAfter(const Duration(seconds: 90));

        Object? error;
        Map<String, dynamic>? result;
        unawaited(api.profilingAnswer(authToken: 'tok', body: body).then<void>(
          (Map<String, dynamic> v) => result = v,
          onError: (Object e) => error = e,
        ));

        async.elapse(const Duration(seconds: 100));

        expect(error, isNull,
            reason: 'must NOT time out at 15s while STT is still running');
        expect(result, isNotNull);
        expect((result!['step'] as Map<String, dynamic>)['kind'], 'done');
      });
    });

    test('still gives up if the server outruns even the 150s budget', () {
      fakeAsync((FakeAsync async) {
        final ApiClient api = apiThatRespondsAfter(const Duration(seconds: 200));

        Object? error;
        unawaited(api.profilingAnswer(authToken: 'tok', body: body).then<void>(
          (_) {},
          onError: (Object e) => error = e,
        ));

        async.elapse(const Duration(seconds: 160));

        expect(error, isA<TimeoutException>(),
            reason: 'the budget is a ceiling, not an infinite wait');
      });
    });
  });

  group('other endpoints keep the 15s default', () {
    test('POST /profiling/session times out at 15s on the same slow server', () {
      fakeAsync((FakeAsync async) {
        final ApiClient api = apiThatRespondsAfter(const Duration(seconds: 90));

        Object? error;
        Map<String, dynamic>? result;
        unawaited(api.profilingStart(authToken: 'tok').then<void>(
          (Map<String, dynamic> v) => result = v,
          onError: (Object e) => error = e,
        ));

        async.elapse(const Duration(seconds: 20));

        expect(result, isNull);
        expect(error, isA<TimeoutException>(),
            reason: 'the long budget must be scoped to /profiling/answer only');
      });
    });
  });
}

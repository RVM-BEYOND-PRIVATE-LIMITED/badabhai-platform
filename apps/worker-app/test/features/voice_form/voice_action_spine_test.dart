import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/observability/analytics.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/voice_form/data/voice_form_action_log.dart';

SessionRepository _session() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

void main() {
  test('flush POSTs the batch to /workers/me/actions/batch, spine shape (#707)',
      () async {
    late String path;
    late Map<String, dynamic> body;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        path = req.url.path;
        body = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response('{}', 201);
      }),
    );

    await VoiceActionSpine(api, _session()).flush(<BbAnalyticsEvent>[
      BbAnalytics.questionAudioPlayed(questionIndex: 3),
      BbAnalytics.profilingAnswerSpoken(questionIndex: 5),
    ]);

    expect(path, '/workers/me/actions/batch');
    final List<dynamic> actions = body['actions'] as List<dynamic>;
    expect(actions, hasLength(2));
    expect(actions[0]['action_type'], 'question_audio_played');
    expect(actions[0]['source_surface'], 'voice_form');
    expect(actions[0]['context'], <String, dynamic>{'question_index': 3});
    expect(actions[1]['action_type'], 'profiling_answer_spoken');
    expect(actions[1]['context'], <String, dynamic>{'question_index': 5});
    // No worker id / text ever in the body (ids/enums/counts only).
    expect(hasNoPii(body), isTrue);
  });

  test('a 403 (consent revoked) is a STOP — swallowed, never thrown (#707)',
      () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client:
          MockClient((http.Request req) async => http.Response('{}', 403)),
    );
    // Must not throw.
    await VoiceActionSpine(api, _session())
        .flush(<BbAnalyticsEvent>[BbAnalytics.questionAudioPlayed(questionIndex: 1)]);
  });

  test('a 5xx / abuse-cap rejection is dropped best-effort (#707)', () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client:
          MockClient((http.Request req) async => http.Response('{}', 429)),
    );
    await VoiceActionSpine(api, _session())
        .flush(<BbAnalyticsEvent>[BbAnalytics.profilingAnswerSpoken(questionIndex: 2)]);
  });

  test('no session token → no POST at all (#707)', () async {
    bool hit = false;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        hit = true;
        return http.Response('{}', 201);
      }),
    );
    await VoiceActionSpine(api, SessionRepository())
        .flush(<BbAnalyticsEvent>[BbAnalytics.questionAudioPlayed(questionIndex: 1)]);
    expect(hit, isFalse, reason: 'nothing to attribute without a session');
  });
}

/// A tiny guard mirroring analytics_pii: the serialized action body carries no
/// phone/email/uuid value and no worker-id key.
bool hasNoPii(Map<String, dynamic> body) {
  final String blob = jsonEncode(body);
  final RegExp pii = RegExp(
    r'(\+?\d[\d\s\-]{8,}|[^@\s]+@[^@\s]+\.[^@\s]+'
    r'|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})',
    caseSensitive: false,
  );
  // Strip bare numbers (counts) from consideration by only scanning quoted strs.
  for (final Match m in RegExp(r':\s*"([^"]*)"').allMatches(blob)) {
    if (pii.hasMatch(m.group(1)!)) return false;
  }
  return !RegExp(r'"[a-z_]*(worker|user|phone)[a-z_]*"\s*:').hasMatch(blob);
}

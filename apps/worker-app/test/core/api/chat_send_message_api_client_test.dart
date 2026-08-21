import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// #870 — the per-submission id rides the POST /chat/message body ADDITIVELY: the
/// body stays `{session_id, text}` and `submission_id` is added ONLY when the
/// caller passes one (non-null). Backward-compatible with a server that predates
/// the key (unknown keys are stripped), so it ships before the backend half.
void main() {
  Future<Map<String, dynamic>> capturePostBody(
    Future<void> Function(ApiClient api) call,
  ) async {
    late Map<String, dynamic> body;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        body = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
            jsonEncode(<String, dynamic>{'reply': 'Theek hai.'}), 200);
      }),
    );
    await call(api);
    return body;
  }

  test('sendMessage(submissionId: x) puts submission_id: x in the body', () async {
    final Map<String, dynamic> body = await capturePostBody(
      (ApiClient api) => api.sendMessage(
        sessionId: 's1',
        authToken: 'tok',
        text: 'cnc operator hoon',
        submissionId: 'sub-123',
      ),
    );

    expect(body['submission_id'], 'sub-123');
    // The existing keys are unchanged.
    expect(body['session_id'], 's1');
    expect(body['text'], 'cnc operator hoon');
  });

  test('sendMessage with a null submissionId omits the key entirely — the body '
      'stays {session_id, text}', () async {
    final Map<String, dynamic> body = await capturePostBody(
      (ApiClient api) => api.sendMessage(
        sessionId: 's1',
        authToken: 'tok',
        text: 'cnc operator hoon',
      ),
    );

    expect(body.containsKey('submission_id'), isFalse,
        reason: 'a null id is absent, never sent as null');
    expect(body.keys.toSet(), <String>{'session_id', 'text'},
        reason: 'byte-identical to the pre-#870 body');
  });
}

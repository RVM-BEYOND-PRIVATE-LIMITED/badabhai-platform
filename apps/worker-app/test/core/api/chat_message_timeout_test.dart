import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';

/// ── #2160 — POST /chat/message GETS ITS OWN, LONGER BUDGET ─────────────────
///
/// A live-news turn runs three server calls (classifier → reply → web search),
/// so it can legitimately outrun the app-wide 15 s while the server is still
/// working. At 15 s the client abandoned an answer the server was about to give
/// and re-sent the same `submission_id` — deduped server-side, but the worker
/// saw an error instead of their news (ADR-0054 §6 R7).
void main() {
  test('the constant is at least the 45 s the issue asks for', () {
    expect(
      kChatMessageTimeout.inSeconds,
      greaterThanOrEqualTo(45),
      reason: "the server's own ceiling is ~37 s; the client must not give up "
          'first',
    );
  });

  test('and it is LONGER than the app-wide default', () {
    expect(kChatMessageTimeout, greaterThan(kRequestTimeout));
  });

  test('sendMessage still posts and parses under its own budget', () async {
    // A smoke check that routing the call through the longer budget did not
    // change the request or the parse. The BUDGET itself is asserted above, on
    // the constant — asserting it by actually waiting would cost 45 s of wall
    // time per run, which is not a trade worth making in the suite.
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        expect(req.url.path, '/chat/message');
        return http.Response(
          jsonEncode(<String, dynamic>{'reply': 'Aaj ki badi khabar...'}),
          201,
        );
      }),
    );

    final ChatReply reply = await api.sendMessage(
      sessionId: 's1',
      authToken: 'tok',
      text: 'aaj ki khabar',
    );
    expect(reply.reply, 'Aaj ki badi khabar...');
  });

  test('every OTHER request keeps the 15 s default', () {
    // The issue is explicit: leave the rest at 15 s. Nothing else fans out to
    // three server calls.
    expect(kRequestTimeout, const Duration(seconds: 15));
  });
}

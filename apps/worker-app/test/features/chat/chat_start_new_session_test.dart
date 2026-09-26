import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';

/// ── "Chat se resume banayein" MINTS A FRESH SESSION (#1566) ──────────────────
///
/// `ensureSession()` resumes `GET /chat/session/latest` first, which would
/// re-attach whatever session the app is holding. [ChatRepositoryImpl.startNewSession]
/// must NOT do that: it drops the cached id and POSTs `/chat/session`.
///
/// #1765 — WHAT THE SERVER DOES WITH THAT POST is not one thing, and this test
/// pins the CLIENT half only (no resume, one POST). Since #1744/#1760 the server
/// reattaches an UNFINISHED interview — which is what a worker who never finished
/// wants — and closes-then-mints when the leftover is an early finish he has
/// already confirmed as his profile.
void main() {
  test('startNewSession POSTs /chat/session and never resumes the old id',
      () async {
    bool latestRequested = false;
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async {
        if (req.url.path == '/chat/session/latest') {
          latestRequested = true;
          return http.Response(jsonEncode(<String, dynamic>{'session_id': 'old'}), 200);
        }
        if (req.url.path == '/chat/session' && req.method == 'POST') {
          return http.Response.bytes(
            utf8.encode(jsonEncode(<String, dynamic>{
              'session_id': 'new',
              'opening_text': 'Naya sawaal',
            })),
            201,
            headers: <String, String>{
              'content-type': 'application/json; charset=utf-8',
            },
          );
        }
        return http.Response('not found', 404);
      }),
    );
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setSession('old');

    final ChatRepositoryImpl repo = ChatRepositoryImpl(api, session);
    final ChatSessionOpening? opening = await repo.startNewSession();

    expect(latestRequested, isFalse,
        reason: 'a fresh start must not resume the ended session');
    expect(session.sessionId, 'new');
    expect(opening, isNotNull);
    expect(opening!.text, 'Naya sawaal');
  });
}

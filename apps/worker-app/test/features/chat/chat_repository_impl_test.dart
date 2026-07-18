import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';

/// A client that fails the test if it is ever hit — the fail-closed guards must
/// short-circuit before any network call.
MockClient _neverCalled() =>
    MockClient((http.Request req) async => fail('network must not be hit'));

ChatRepositoryImpl _repo(SessionRepository session) {
  return ChatRepositoryImpl(
    ApiClient(baseUrl: 'http://test', client: _neverCalled()),
    session,
  );
}

void main() {
  test('ensureSession fails closed with UnauthorizedFailure when no token', () {
    final ChatRepositoryImpl repo = _repo(SessionRepository());
    expect(repo.ensureSession(), throwsA(isA<UnauthorizedFailure>()));
  });

  test('sendMessage fails closed with UnauthorizedFailure when no token', () {
    final ChatRepositoryImpl repo = _repo(SessionRepository());
    expect(repo.sendMessage('hi'), throwsA(isA<UnauthorizedFailure>()));
  });

  // #343 — this previously asserted that a token-holding worker with no open
  // session got UnauthorizedFailure FOREVER. That "fail closed" was the defect,
  // not a safeguard: one failed session-open (routine on 2G) silently discarded
  // every later answer. The authenticated worker must self-heal instead. The
  // genuine fail-closed guards — no token, no send — are the two tests above and
  // still hold.
  group('lazy session self-heal (#343)', () {
    test('sendMessage opens the session when one was never opened, then sends',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

      final List<String> hitPaths = <String>[];
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            hitPaths.add(req.url.path);
            if (req.url.path == '/chat/session') {
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': 's1'}), 201);
            }
            return http.Response(
                jsonEncode(<String, dynamic>{'reply': 'Got it.'}), 200);
          }),
        ),
        session,
      );

      final ChatTurn turn = await repo.sendMessage('hi');

      expect(turn.reply, 'Got it.');
      expect(session.sessionId, 's1', reason: 'the session healed itself');
      expect(hitPaths, <String>['/chat/session', '/chat/message'],
          reason: 'one session-open, then the send — in that order');
    });

    test('a still-failing session-open surfaces the failure (never silence)',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient(
              (http.Request req) async => throw const SocketException('down')),
        ),
        session,
      );

      // A Failure — NOT a silently-swallowed no-op: the bloc marks the bubble
      // failed and offers retry on the back of this throw.
      await expectLater(repo.sendMessage('hi'), throwsA(isA<Failure>()));
    });
  });
}

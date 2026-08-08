import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
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
            // No prior session to resume (brand-new worker) → the open path runs.
            if (req.url.path == '/chat/session/latest') {
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': null}), 200);
            }
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
      expect(
          hitPaths,
          <String>['/chat/session/latest', '/chat/session', '/chat/message'],
          reason: 'resume-check (none), then session-open, then the send');
    });

    test('resumes the worker\'s latest session instead of opening a new one',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

      final List<String> hitPaths = <String>[];
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            hitPaths.add(req.url.path);
            if (req.url.path == '/chat/session/latest') {
              return http.Response(
                  jsonEncode(<String, dynamic>{'session_id': 'prior-1'}), 200);
            }
            return http.Response(
                jsonEncode(<String, dynamic>{'reply': 'Got it.'}), 200);
          }),
        ),
        session,
      );

      final String? opener = await repo.ensureSession();

      // Re-attached to the signup session (so loadHistory redraws its Q&A) — a
      // resume serves NO opener, and it must NOT mint a fresh /chat/session.
      expect(opener, isNull);
      expect(session.sessionId, 'prior-1',
          reason: 'the Bada Bhai tab resumes the existing session');
      expect(hitPaths, <String>['/chat/session/latest'],
          reason: 'latest found → resume, no new session-open');
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

  // #478 + honesty cues — the reply's new fields must reach the ChatTurn the
  // bloc consumes, or the named-gaps helper and the blocked/mock cues go dark.
  test('sendMessage carries unanswered_essentials, blocked and is_mock through',
      () async {
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setSession('s1');
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'reply': 'Aur bataiye.',
                'is_mock': true,
                'blocked': false,
                'suggested_followups': <String>['CNC', 'VMC'],
                'unanswered_essentials': <String>['machines', 'experience'],
              }),
              201,
            )),
      ),
      session,
    );

    final ChatTurn turn = await repo.sendMessage('hi');
    expect(turn.reply, 'Aur bataiye.');
    expect(turn.isMock, isTrue);
    expect(turn.blocked, isFalse);
    expect(turn.followups, <String>['CNC', 'VMC']);
    expect(turn.unansweredEssentials, <String>['machines', 'experience']);
  });

  test('sendMessage carries progress, question_kind and occupation through (#649)',
      () async {
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setSession('s1');
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'reply': 'Aap darzi hain?',
                'progress': <String, dynamic>{'answered': 2, 'total': 9},
                'question_kind': 'disambiguate',
                'occupation_label': 'darzi',
              }),
              201,
            )),
      ),
      session,
    );

    final ChatTurn turn = await repo.sendMessage('hi');
    expect(turn.progress?.answered, 2);
    expect(turn.progress?.total, 9);
    expect(turn.questionKind, ChatQuestionKind.disambiguate);
    expect(turn.occupationLabel, 'darzi');
  });

  test('a session_ended reply drops the cached chat session id (#649 re-verify)',
      () async {
    final SessionRepository session = SessionRepository()
      ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
      ..setSession('s1');
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async => http.Response(
              jsonEncode(<String, dynamic>{
                'reply': 'Interview poori hui.',
                'session_ended': true,
              }),
              201,
            )),
      ),
      session,
    );

    expect(session.sessionId, 's1');
    await repo.sendMessage('hi');
    expect(session.sessionId, isNull,
        reason: 'session_ended must clear the cached id so "start a fresh chat" '
            'on the Resume/Profile tabs still works');
  });

  // #502 transcript hydration — the persisted transcript is redrawn as bubbles.
  group('loadHistory (#502)', () {
    test('no open session -> [] (best-effort, never hits the network)', () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');
      // No setSession -> sessionId null.
      final ChatRepositoryImpl repo = _repo(session);
      expect(await repo.loadHistory(), isEmpty);
    });

    test('maps rows to bubbles: inbound=worker, {{worker_name}} stripped, '
        'null-body dropped, order preserved', () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
        ..setSession('s1');
      late http.Request captured;
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async {
            captured = req;
            return http.Response(
              jsonEncode(<String, dynamic>{
                'messages': <Map<String, dynamic>>[
                  <String, dynamic>{
                    'direction': 'outbound',
                    'body_text': '{{worker_name}} ji, Namaste!',
                    'created_at': '2026-07-23T10:00:00.000Z',
                  },
                  <String, dynamic>{
                    'direction': 'inbound',
                    'body_text': 'CNC operator hoon',
                    'created_at': '2026-07-23T10:01:00.000Z',
                  },
                  // A voice row before its transcript lands — dropped, not empty.
                  <String, dynamic>{
                    'direction': 'inbound',
                    'body_text': null,
                    'created_at': '2026-07-23T10:02:00.000Z',
                  },
                ],
              }),
              200,
            );
          }),
        ),
        session,
      );

      final List<ChatMessage> history = await repo.loadHistory();

      expect(captured.url.path, '/chat/sessions/s1/messages');
      expect(captured.headers['authorization'], 'Bearer tok');
      expect(history.length, 2, reason: 'the null-body voice row is dropped');
      expect(history[0].fromWorker, isFalse);
      expect(history[0].text, 'Namaste!',
          reason: 'the {{worker_name}} vocative is stripped for the name-less client');
      expect(history[1].fromWorker, isTrue);
      expect(history[1].text, 'CNC operator hoon');
    });

    test('a server error degrades to [] — hydration never blocks chat-open',
        () async {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
        ..setSession('s1');
      final ChatRepositoryImpl repo = ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient((http.Request req) async =>
              http.Response('{"message":"boom"}', 500)),
        ),
        session,
      );
      expect(await repo.loadHistory(), isEmpty);
    });
  });
}

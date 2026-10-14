import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// ── #2258 (Part B of #2224): the cold reopen draws the marker ─────────────
///
/// The live close draws "End of conversation" from the turn itself. A cold
/// reopen has only the transcript — so `session_ended_at` (#2235) has to put
/// the marker back after the bubble the session closed on.
void main() {
  group('SessionTranscript parses session_ended_at defensively', () {
    test('present', () {
      final SessionTranscript t = SessionTranscript.fromJson(<String, dynamic>{
        'messages': <dynamic>[],
        'session_ended_at': '2026-10-14T09:30:00.000Z',
      });
      expect(t.sessionEndedAt, DateTime.utc(2026, 10, 14, 9, 30));
    });

    test('absent, null, non-string and malformed are all null — never a throw',
        () {
      for (final Object? v in <Object?>[null, 42, 'not-a-date', '']) {
        final Map<String, dynamic> json = <String, dynamic>{
          'messages': <dynamic>[],
          'session_ended_at': v,
        };
        expect(SessionTranscript.fromJson(json).sessionEndedAt, isNull,
            reason: '$v');
      }
      expect(
        SessionTranscript.fromJson(<String, dynamic>{'messages': <dynamic>[]})
            .sessionEndedAt,
        isNull,
      );
    });
  });

  group('loadHistory marks the closing bubble over KEPT bubbles', () {
    ChatRepositoryImpl repoFor(Map<String, dynamic> body) {
      final SessionRepository session = SessionRepository()
        ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok')
        ..setSession('s1');
      return ChatRepositoryImpl(
        ApiClient(
          baseUrl: 'http://test',
          client: MockClient(
            (http.Request req) async => http.Response(jsonEncode(body), 200),
          ),
        ),
        session,
      );
    }

    Map<String, dynamic> row(String direction, String? body, String at) =>
        <String, dynamic>{
          'direction': direction,
          'body_text': body,
          'created_at': at,
        };

    test('a dropped voice row before the close does not shift the mark',
        () async {
      final ChatRepositoryImpl repo = repoFor(<String, dynamic>{
        'messages': <Map<String, dynamic>>[
          row('outbound', 'Aap kaun sa kaam karte hain?', '2026-10-14T09:00:00Z'),
          // A voice row with no transcript yet: DROPPED from the redraw.
          row('inbound', null, '2026-10-14T09:10:00Z'),
          row('inbound', 'fitter', '2026-10-14T09:20:00Z'),
          row('outbound', 'Aapki baat poori ho gayi.', '2026-10-14T09:30:00Z'),
          // After the close — the résumé menu's reply.
          row('inbound', 'resume', '2026-10-14T09:40:00Z'),
          row('outbound', 'Resume menu', '2026-10-14T09:41:00Z'),
        ],
        'session_ended_at': '2026-10-14T09:30:00.000Z',
      });

      final List<ChatMessage> history = await repo.loadHistory();

      expect(history.length, 5, reason: 'the null-body row is dropped');
      final int closing = history.indexWhere((ChatMessage m) => m.closesSession);
      expect(closing, 2, reason: 'index over KEPT bubbles, not raw rows');
      expect(history[closing].text, 'Aapki baat poori ho gayi.');
      expect(history.where((ChatMessage m) => m.closesSession).length, 1);
    });

    test('no session_ended_at (live session / older API): nothing marked',
        () async {
      final ChatRepositoryImpl repo = repoFor(<String, dynamic>{
        'messages': <Map<String, dynamic>>[
          row('outbound', 'Aap kaun sa kaam karte hain?', '2026-10-14T09:00:00Z'),
          row('inbound', 'fitter', '2026-10-14T09:20:00Z'),
        ],
      });
      final List<ChatMessage> history = await repo.loadHistory();
      expect(history.any((ChatMessage m) => m.closesSession), isFalse);
    });

    test('a malformed session_ended_at degrades to no mark', () async {
      final ChatRepositoryImpl repo = repoFor(<String, dynamic>{
        'messages': <Map<String, dynamic>>[
          row('outbound', 'Done.', '2026-10-14T09:30:00Z'),
        ],
        'session_ended_at': 'yesterday',
      });
      final List<ChatMessage> history = await repo.loadHistory();
      expect(history.any((ChatMessage m) => m.closesSession), isFalse);
    });
  });

  group('ChatBloc hydration places the marker', () {
    late MockChatRepository repo;

    setUp(() {
      repo = MockChatRepository();
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
    });

    Future<void> settle() =>
        Future<void>.delayed(const Duration(milliseconds: 30));

    test('a cold reopen of a finished session sets sessionEndedAfterIndex',
        () async {
      when(() => repo.loadHistory()).thenAnswer(
        (_) async => const <ChatMessage>[
          ChatMessage(text: 'Kya kaam?', fromWorker: false),
          ChatMessage(text: 'fitter', fromWorker: true),
          ChatMessage(
            text: 'Aapki baat poori ho gayi.',
            fromWorker: false,
            closesSession: true,
          ),
          ChatMessage(text: 'resume', fromWorker: true),
        ],
      );
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();

      final int? at = bloc.state.sessionEndedAfterIndex;
      expect(at, isNotNull);
      expect(bloc.state.messages[at!].text, 'Aapki baat poori ho gayi.');
      expect(at, lessThan(bloc.state.messages.length - 1),
          reason: 'later bubbles render below the marker');
    });

    test('no closing bubble in the redraw: no marker', () async {
      when(() => repo.loadHistory()).thenAnswer(
        (_) async => const <ChatMessage>[
          ChatMessage(text: 'Kya kaam?', fromWorker: false),
          ChatMessage(text: 'fitter', fromWorker: true),
        ],
      );
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();
      expect(bloc.state.sessionEndedAfterIndex, isNull);
    });

    test('a restart clears a redrawn marker', () async {
      when(() => repo.loadHistory()).thenAnswer(
        (_) async => const <ChatMessage>[
          ChatMessage(text: 'Done.', fromWorker: false, closesSession: true),
        ],
      );
      when(() => repo.startNewSession()).thenAnswer((_) async => null);
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();
      expect(bloc.state.sessionEndedAfterIndex, isNotNull);

      bloc.add(const ChatSessionRestarted());
      await settle();
      expect(bloc.state.sessionEndedAfterIndex, isNull);
    });

    test('a marker already placed by a LIVE close is never moved', () async {
      // The live close sets the marker on the closing turn; a later hydration
      // carrying an older closing bubble must not re-point it.
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => const ChatTurn(reply: 'Aapki baat poori ho gayi.', sessionEnded: true),
      );
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();
      bloc.add(const ChatMessageSent('fitter'));
      await settle();
      final int? live = bloc.state.sessionEndedAfterIndex;
      expect(live, isNotNull);

      when(() => repo.loadHistory()).thenAnswer(
        (_) async => const <ChatMessage>[
          ChatMessage(text: 'Older close', fromWorker: false, closesSession: true),
        ],
      );
      bloc.add(const ChatStarted());
      await settle();
      expect(bloc.state.sessionEndedAfterIndex, live);
    });
  });
}

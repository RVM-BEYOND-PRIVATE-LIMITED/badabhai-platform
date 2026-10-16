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
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// ── #2331: a cold reopen of a FINISHED chat draws the done CTA ────────────
///
/// The live close lights "Ho gaya — meri profile banaiye" from the turn itself
/// (`extraction_ready: true`). A cold reopen has only the transcript, so the
/// server's `extraction_ready` (#2332) must put the CTA back — otherwise a
/// finished chat shows the divider and no way on until the worker sends again.
///
/// It rides the SAME closing bubble as the #2258 "End of conversation" marker,
/// and reads false (absent) on a live/abandoned session or a form handover.
void main() {
  group('SessionTranscript.extractionReady parses defensively (#371 style)', () {
    SessionTranscript parse(Object? value) => SessionTranscript.fromJson(
          <String, dynamic>{'messages': <dynamic>[], 'extraction_ready': value},
        );

    test('reads extraction_ready: true', () {
      expect(parse(true).extractionReady, isTrue);
    });

    test('reads extraction_ready: false', () {
      expect(parse(false).extractionReady, isFalse);
    });

    test('an ABSENT extraction_ready defaults to false (never true)', () {
      expect(
        SessionTranscript.fromJson(<String, dynamic>{'messages': <dynamic>[]})
            .extractionReady,
        isFalse,
      );
    });

    test('a null / non-bool extraction_ready degrades to false, not a throw',
        () {
      for (final Object? v in <Object?>[null, 1, 'true', <String>[]]) {
        expect(parse(v).extractionReady, isFalse, reason: '$v');
      }
    });
  });

  group('loadHistory marks the closing bubble extraction-ready', () {
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

    Map<String, dynamic> row(String direction, String body, String at) =>
        <String, dynamic>{
          'direction': direction,
          'body_text': body,
          'created_at': at,
        };

    Map<String, dynamic> finished({required bool extractionReady}) =>
        <String, dynamic>{
          'messages': <Map<String, dynamic>>[
            row('outbound', 'Kya kaam?', '2026-10-14T09:00:00Z'),
            row('inbound', 'fitter', '2026-10-14T09:20:00Z'),
            row('outbound', 'Aapki baat poori ho gayi.', '2026-10-14T09:30:00Z'),
          ],
          'session_ended_at': '2026-10-14T09:30:00.000Z',
          if (extractionReady) 'extraction_ready': true,
        };

    test('a finished close with the field marks its closing bubble ready',
        () async {
      final List<ChatMessage> history =
          await repoFor(finished(extractionReady: true)).loadHistory();

      final ChatMessage closing =
          history.firstWhere((ChatMessage m) => m.closesSession);
      expect(closing.extractionReady, isTrue);
      expect(history.where((ChatMessage m) => m.extractionReady).length, 1,
          reason: 'only the closing bubble carries the gate');
    });

    test('a close WITHOUT the field (abandoned / form handover) stays dark',
        () async {
      final List<ChatMessage> history =
          await repoFor(finished(extractionReady: false)).loadHistory();

      expect(history.any((ChatMessage m) => m.closesSession), isTrue);
      expect(history.any((ChatMessage m) => m.extractionReady), isFalse);
    });

    test('the field without a session_ended_at lights nothing', () async {
      final List<ChatMessage> history = await repoFor(<String, dynamic>{
        'messages': <Map<String, dynamic>>[
          row('outbound', 'Kya kaam?', '2026-10-14T09:00:00Z'),
        ],
        'extraction_ready': true,
      }).loadHistory();

      expect(history.any((ChatMessage m) => m.extractionReady), isFalse);
    });
  });

  group('ChatBloc cold reopen latches extractionReady from the redraw', () {
    late MockChatRepository repo;

    setUp(() {
      repo = MockChatRepository();
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
    });

    Future<void> settle() =>
        Future<void>.delayed(const Duration(milliseconds: 30));

    test('a finished close with the field flips the state ready (no send)',
        () async {
      when(() => repo.loadHistory()).thenAnswer(
        (_) async => const <ChatMessage>[
          ChatMessage(text: 'Kya kaam?', fromWorker: false),
          ChatMessage(text: 'fitter', fromWorker: true),
          ChatMessage(
            text: 'Aapki baat poori ho gayi.',
            fromWorker: false,
            closesSession: true,
            extractionReady: true,
          ),
        ],
      );
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();

      expect(bloc.state.extractionReady, isTrue);
      expect(bloc.state.sessionEndedAfterIndex, isNotNull);
    });

    test('an absent field (abandoned / handover) leaves the state not ready',
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
        ],
      );
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();

      expect(bloc.state.extractionReady, isFalse);
    });
  });
}

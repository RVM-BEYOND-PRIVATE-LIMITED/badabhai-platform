import 'dart:async';
import 'dart:convert';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/session_repository.dart';
import 'package:badabhai_worker_app/features/chat/data/chat_repository_impl.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

/// The SERVER-SERVED one-shot opener reaching the worker's screen.
///
/// `POST /chat/session` may now answer with `opening_text` — the engine's own
/// invitation to answer every topic in one message — and the client swaps it into
/// bubble 0. Three properties are load-bearing and each is measured here:
///
///   1. It REPLACES bubble 0, never appends. Two openers in a row, the canned one
///      asking `role` outright and the served one inviting everything, reads as an
///      app that did not listen to the answer it just got.
///   2. Absent / blank / unreachable DEGRADES to `kChatOpeningText`. The chat must
///      never open on an empty bubble, and an older API must stay compatible.
///   3. It is RENDERED ONLY, never posted. If the opener ever entered the stored
///      transcript, extraction would read a twelve-topic menu as worker answers —
///      the exact fabrication shape PR #493 exists to prevent.
class MockChatRepository extends Mock implements ChatRepository {}

const String _served =
    'Namaste. Main Bada Bhai. Koi test nahi, bas baat.\n'
    'Ek hi message mein itna bata sakte hain?\n'
    'aap kaunsa kaam karte hain\n'
    'kaunsi machine\n'
    'kitne saal ka experience hai';

SessionRepository _authed() => SessionRepository()
  ..setWorker(phone: '+910000000000', workerId: 'w1', sessionToken: 'tok');

void main() {
  // --- 1. the model ---------------------------------------------------------

  group('ChatSessionStart', () {
    test('carries the served opener when the API sends one', () {
      final ChatSessionStart start = ChatSessionStart.fromJson(
        <String, dynamic>{'session_id': 's1', 'opening_text': _served},
      );
      expect(start.sessionId, 's1');
      expect(start.openingText, _served);
    });

    test('an ABSENT key is null — an older API build stays compatible', () {
      // CHAT_ONE_SHOT_OPENER_ENABLED off, or an API that predates the field.
      // apps/api omits the key rather than sending null, so this is the common
      // shape, not an error path.
      final ChatSessionStart start =
          ChatSessionStart.fromJson(<String, dynamic>{'session_id': 's1'});
      expect(start.openingText, isNull);
    });

    test('a BLANK opener is normalised to null, never rendered', () {
      // Otherwise bada bhai greets the worker with an empty bubble.
      for (final Object? blank in <Object?>[null, '', '   ', '\n\n', 42]) {
        final ChatSessionStart start = ChatSessionStart.fromJson(
          <String, dynamic>{'session_id': 's1', 'opening_text': blank},
        );
        expect(start.openingText, isNull, reason: 'blank: ${blank.runtimeType}');
      }
    });
  });

  // --- 2. the client + repository seam --------------------------------------

  test('ApiClient.startSession reads opening_text off /chat/session', () async {
    final ApiClient api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((http.Request req) async => http.Response(
            jsonEncode(<String, dynamic>{
              'session_id': 's1',
              'status': 'active',
              'opening_text': _served,
            }),
            201,
          )),
    );

    final ChatSessionStart start = await api.startSession(authToken: 'tok');

    expect(start.sessionId, 's1');
    expect(start.openingText, _served);
  });

  test('ensureSession returns the opener on OPEN and null when already open',
      () async {
    final SessionRepository session = _authed();
    int opens = 0;
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          opens++;
          return http.Response(
            jsonEncode(<String, dynamic>{
              'session_id': 's1',
              'opening_text': _served,
            }),
            201,
          );
        }),
      ),
      session,
    );

    expect(await repo.ensureSession(), _served);
    // Second call is the already-open no-op: null, and NO second network hop.
    // Re-greeting a worker who is already mid-conversation would be worse than
    // showing nothing.
    expect(await repo.ensureSession(), isNull);
    expect(opens, 1);
  });

  test('THE OPENER IS NEVER POSTED — it stays out of the stored transcript',
      () async {
    // The load-bearing one. The opener names ~12 topics; posted as a message it
    // would reach `/profile/extract`, and on the `messages`-absent fallback that
    // PR #493 documents as its rollback lever the detector would read those
    // topic names as things the worker said.
    final List<String> bodies = <String>[];
    final ChatRepositoryImpl repo = ChatRepositoryImpl(
      ApiClient(
        baseUrl: 'http://test',
        client: MockClient((http.Request req) async {
          bodies.add(req.body);
          if (req.url.path == '/chat/session') {
            return http.Response(
              jsonEncode(<String, dynamic>{
                'session_id': 's1',
                'opening_text': _served,
              }),
              201,
            );
          }
          return http.Response(
              jsonEncode(<String, dynamic>{'reply': 'Theek hai.'}), 200);
        }),
      ),
      _authed(),
    );

    await repo.ensureSession();
    await repo.sendMessage('vmc operator hu');

    expect(bodies.any((String b) => b.contains('Bada Bhai')), isFalse);
    expect(bodies.any((String b) => b.contains('kaunsi machine')), isFalse);
    expect(bodies.last, contains('vmc operator hu'));
  });

  // --- 3. the bloc ----------------------------------------------------------

  group('ChatBloc bubble 0', () {
    late MockChatRepository repo;
    setUp(() => repo = MockChatRepository());

    blocTest<ChatBloc, ChatState>(
      'a served opener REPLACES the canned one — it never appends a second',
      build: () {
        when(() => repo.ensureSession()).thenAnswer((_) async => _served);
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatStarted()),
      expect: () => const <ChatState>[
        ChatState(
          messages: <ChatMessage>[ChatMessage(text: _served, fromWorker: false)],
          initializing: false,
        ),
      ],
      verify: (ChatBloc b) {
        expect(b.state.messages.length, 1, reason: 'replaced, not appended');
        expect(b.state.messages.single.text, isNot(kChatOpeningText));
      },
    );

    blocTest<ChatBloc, ChatState>(
      'no served opener keeps kChatOpeningText — the chat never opens blank',
      build: () {
        when(() => repo.ensureSession()).thenAnswer((_) async => null);
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatStarted()),
      expect: () => const <ChatState>[
        ChatState(
          messages: <ChatMessage>[kChatOpeningMessage],
          initializing: false,
        ),
      ],
    );

    blocTest<ChatBloc, ChatState>(
      'a whitespace-only opener also keeps the fallback',
      build: () {
        when(() => repo.ensureSession()).thenAnswer((_) async => '   \n ');
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatStarted()),
      expect: () => const <ChatState>[
        ChatState(
          messages: <ChatMessage>[kChatOpeningMessage],
          initializing: false,
        ),
      ],
    );

    blocTest<ChatBloc, ChatState>(
      'a failed session-open keeps the fallback AND still surfaces the banner',
      build: () {
        when(() => repo.ensureSession()).thenThrow(const NetworkFailure());
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatStarted()),
      expect: () => const <ChatState>[
        ChatState(
          messages: <ChatMessage>[kChatOpeningMessage],
          initializing: false,
          sessionFailed: true,
        ),
      ],
    );

    blocTest<ChatBloc, ChatState>(
      'a message typed BEFORE the session resolves is not lost by the swap',
      build: () {
        // bloc 8.x runs events concurrently (no transformer here), so a worker on
        // a slow link can send before `ensureSession` returns. The swap rebuilds
        // from `state.messages` at emit time for exactly this reason — a list
        // captured before the await would silently drop their message.
        final Completer<String?> gate = Completer<String?>();
        when(() => repo.ensureSession()).thenAnswer((_) => gate.future);
        when(() => repo.sendMessage(any()))
            .thenAnswer((_) async => const ChatTurn(reply: 'Theek hai.'));
        Future<void>.delayed(
          const Duration(milliseconds: 30),
          () => gate.complete(_served),
        );
        return ChatBloc(repo);
      },
      act: (ChatBloc b) async {
        b.add(const ChatStarted());
        b.add(const ChatMessageSent('vmc operator hu'));
      },
      wait: const Duration(milliseconds: 120),
      verify: (ChatBloc b) {
        final List<ChatMessage> msgs = b.state.messages;
        expect(msgs.first.text, _served, reason: 'bubble 0 was swapped');
        expect(
          msgs.map((ChatMessage m) => m.text),
          contains('vmc operator hu'),
          reason: 'the racing worker message survived the swap',
        );
        expect(msgs.map((ChatMessage m) => m.text), contains('Theek hai.'));
      },
    );
  });
}

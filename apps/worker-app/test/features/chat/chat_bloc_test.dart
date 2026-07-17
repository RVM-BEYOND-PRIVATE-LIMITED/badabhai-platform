import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

const ChatMessage _opening = ChatMessage(
  text: 'Bada Bhai here. Which machines do you run?',
  fromWorker: false,
);

void main() {
  late MockChatRepository repo;
  setUp(() => repo = MockChatRepository());

  blocTest<ChatBloc, ChatState>(
    'ChatStarted opens the session and drops the spinner',
    build: () {
      when(() => repo.ensureSession()).thenAnswer((_) async {});
      return ChatBloc(repo);
    },
    act: (ChatBloc b) => b.add(const ChatStarted()),
    expect: () => const <ChatState>[
      ChatState(messages: <ChatMessage>[_opening], initializing: false),
    ],
    verify: (_) => verify(() => repo.ensureSession()).called(1),
  );

  blocTest<ChatBloc, ChatState>(
    'ChatStarted still drops the spinner when ensureSession fails',
    build: () {
      when(() => repo.ensureSession()).thenThrow(const NetworkFailure());
      return ChatBloc(repo);
    },
    act: (ChatBloc b) => b.add(const ChatStarted()),
    expect: () => const <ChatState>[
      ChatState(messages: <ChatMessage>[_opening], initializing: false),
    ],
    verify: (_) => verify(() => repo.ensureSession()).called(1),
  );

  blocTest<ChatBloc, ChatState>(
    'ChatMessageSent appends the worker message, shows typing, then the reply + chips',
    build: () {
      when(() => repo.ensureSession()).thenAnswer((_) async {});
      when(() => repo.sendMessage(any())).thenAnswer((_) async =>
          const ChatTurn(reply: 'Got it.', followups: <String>['Haan', 'Nahi']));
      return ChatBloc(repo);
    },
    act: (ChatBloc b) {
      b.add(const ChatStarted());
      b.add(const ChatMessageSent('cnc'));
    },
    expect: () => const <ChatState>[
      ChatState(messages: <ChatMessage>[_opening], initializing: false),
      // Worker bubble appended + typing indicator on.
      ChatState(
        messages: <ChatMessage>[
          _opening,
          ChatMessage(text: 'cnc', fromWorker: true),
        ],
        initializing: false,
        sending: true,
      ),
      // Reply appended, typing off, followup chips carried through.
      ChatState(
        messages: <ChatMessage>[
          _opening,
          ChatMessage(text: 'cnc', fromWorker: true),
          ChatMessage(text: 'Got it.', fromWorker: false),
        ],
        initializing: false,
        followups: <String>['Haan', 'Nahi'],
      ),
    ],
  );

  blocTest<ChatBloc, ChatState>(
    'ChatVoiceMerged appends transcript + reply LOCALLY (no network resend)',
    build: () => ChatBloc(repo),
    seed: () =>
        const ChatState(messages: <ChatMessage>[_opening], initializing: false),
    act: (ChatBloc b) => b.add(const ChatVoiceMerged(
      transcript: 'CNC par 4 saal ka anubhav.',
      reply: 'Badhiya! Kaunsa control chalate ho?',
    )),
    expect: () => const <ChatState>[
      ChatState(
        messages: <ChatMessage>[
          _opening,
          ChatMessage(text: 'CNC par 4 saal ka anubhav.', fromWorker: true),
          ChatMessage(
              text: 'Badhiya! Kaunsa control chalate ho?', fromWorker: false),
        ],
        initializing: false,
      ),
    ],
    // The voice pipeline already sent the transcript server-side — a resend
    // here would double the message.
    verify: (_) => verifyNever(() => repo.sendMessage(any())),
  );

  blocTest<ChatBloc, ChatState>(
    'a send failure keeps the worker message and adds no reply (frozen UI)',
    build: () {
      when(() => repo.ensureSession()).thenAnswer((_) async {});
      when(() => repo.sendMessage(any())).thenThrow(const NetworkFailure());
      return ChatBloc(repo);
    },
    seed: () =>
        const ChatState(messages: <ChatMessage>[_opening], initializing: false),
    act: (ChatBloc b) => b.add(const ChatMessageSent('cnc')),
    expect: () => const <ChatState>[
      // Typing on while the send is in flight.
      ChatState(
        messages: <ChatMessage>[
          _opening,
          ChatMessage(text: 'cnc', fromWorker: true),
        ],
        initializing: false,
        sending: true,
      ),
      // Failure: keep the worker message, drop the typing indicator, no reply.
      ChatState(
        messages: <ChatMessage>[
          _opening,
          ChatMessage(text: 'cnc', fromWorker: true),
        ],
        initializing: false,
      ),
    ],
  );

  // #344 — bloc 8.x runs handlers CONCURRENTLY by default. The reply emit used
  // to spread a `withWorker` list captured BEFORE the await, so a slow reply
  // re-emitted a stale transcript and erased anything appended meanwhile.
  group('concurrent sends (#344)', () {
    test('a slow reply does not erase bubbles from a later send', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async {});
      // A is slow, B is fast → B's bubble+reply land while A is still in flight,
      // so A's reply emit is the one that used to clobber them.
      when(() => repo.sendMessage('A')).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        return const ChatTurn(reply: 'replyA');
      });
      when(() => repo.sendMessage('B')).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 10));
        return const ChatTurn(reply: 'replyB');
      });

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('A'));
      bloc.add(const ChatMessageSent('B'));
      await Future<void>.delayed(const Duration(milliseconds: 300));

      final List<String> texts =
          bloc.state.messages.map((ChatMessage m) => m.text).toList();

      // Pre-fix this was [opening, A, replyA] — B and replyB were erased from
      // the worker's visible transcript.
      expect(texts, containsAll(<String>['A', 'B', 'replyA', 'replyB']),
          reason: 'no bubble may be dropped by a concurrent send');
      expect(bloc.state.sending, isFalse,
          reason: 'both replies landed → indicator off');
    });

    test('the typing indicator stays up until the LAST reply lands', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async {});
      when(() => repo.sendMessage('A')).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 150));
        return const ChatTurn(reply: 'replyA');
      });
      when(() => repo.sendMessage('B')).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 10));
        return const ChatTurn(reply: 'replyB');
      });

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('A'));
      bloc.add(const ChatMessageSent('B'));

      // B has replied, A has not: the worker is still waiting on a reply, so the
      // indicator must NOT have been switched off by B's fast return.
      await Future<void>.delayed(const Duration(milliseconds: 60));
      expect(bloc.state.sending, isTrue,
          reason: "B's reply must not clear A's in-flight indicator");

      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(bloc.state.sending, isFalse);
    });

    test('a voice merge mid-send keeps both the send and the voice bubbles',
        () async {
      when(() => repo.ensureSession()).thenAnswer((_) async {});
      when(() => repo.sendMessage('typed')).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        return const ChatTurn(reply: 'typedReply');
      });

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('typed'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      // Voice note completes while the typed send is still awaiting its reply.
      bloc.add(const ChatVoiceMerged(
          transcript: 'voiceText', reply: 'voiceReply'));
      await Future<void>.delayed(const Duration(milliseconds: 250));

      final List<String> texts =
          bloc.state.messages.map((ChatMessage m) => m.text).toList();
      expect(
        texts,
        containsAll(
            <String>['typed', 'voiceText', 'voiceReply', 'typedReply']),
        reason: 'the typed reply must not erase the merged voice transcript',
      );
    });
  });
}

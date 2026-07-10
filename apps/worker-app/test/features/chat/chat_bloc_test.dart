import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
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
    'ChatMessageSent appends the worker message then the reply',
    build: () {
      when(() => repo.ensureSession()).thenAnswer((_) async {});
      when(() => repo.sendMessage(any())).thenAnswer((_) async => 'Got it.');
      return ChatBloc(repo);
    },
    act: (ChatBloc b) {
      b.add(const ChatStarted());
      b.add(const ChatMessageSent('cnc'));
    },
    expect: () => const <ChatState>[
      ChatState(messages: <ChatMessage>[_opening], initializing: false),
      ChatState(
        messages: <ChatMessage>[
          _opening,
          ChatMessage(text: 'cnc', fromWorker: true),
        ],
        initializing: false,
      ),
      ChatState(
        messages: <ChatMessage>[
          _opening,
          ChatMessage(text: 'cnc', fromWorker: true),
          ChatMessage(text: 'Got it.', fromWorker: false),
        ],
        initializing: false,
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
      ChatState(
        messages: <ChatMessage>[
          _opening,
          ChatMessage(text: 'cnc', fromWorker: true),
        ],
        initializing: false,
      ),
    ],
  );
}

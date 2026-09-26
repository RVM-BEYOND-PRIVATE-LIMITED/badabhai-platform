import 'dart:async';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatQuestionKind;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/observability/analytics.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

const String _recap = 'Namaste. Aapki profile taiyaar hai. Ab tak yeh hua hai.\n'
    'Aapne ab tak 2 jobs par apply kiya hai.';
const List<ChatOption> _recapOptions = <ChatOption>[
  ChatOption(optionKey: 'companion_jobs_tab', labelText: 'Sabhi jobs dekhein'),
  ChatOption(optionKey: 'companion_resume', labelText: 'Resume badlein'),
];

ChatTurn _companion(String reply, {String? digestKey}) => ChatTurn(
      reply: reply,
      followups: <String>[for (final ChatOption o in _recapOptions) o.labelText],
      suggestedOptions: _recapOptions,
      questionKind: ChatQuestionKind.disambiguate,
      ttsText: 'नमस्ते।',
      companion: true,
      digestKey: digestKey,
    );

/// ADR-0044 — the Bada Bhai tab's companion mode, at the bloc.
void main() {
  late MockChatRepository repo;

  setUp(() {
    repo = MockChatRepository();
    when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[]);
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
  });

  group('ChatCompanionStarted', () {
    blocTest<ChatBloc, ChatState>(
      'a companion worker: ONE emit — the recap replaces the canned question; no session is touched',
      build: () {
        when(() => repo.openCompanion())
            .thenAnswer((_) async => _companion(_recap, digestKey: 'k1'));
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatCompanionStarted()),
      expect: () => <Matcher>[
        isA<ChatState>()
            .having((ChatState s) => s.initializing, 'initializing', false)
            .having((ChatState s) => s.companion, 'companion', true)
            .having((ChatState s) => s.messages.map((ChatMessage m) => m.text).toList(),
                'messages', <String>[_recap])
            .having((ChatState s) => s.messages.single.ttsText, 'tts', 'नमस्ते।')
            .having((ChatState s) => s.suggestedOptions, 'options', _recapOptions)
            .having((ChatState s) => s.questionKind, 'kind', ChatQuestionKind.disambiguate),
      ],
      verify: (_) {
        verifyNever(() => repo.ensureSession());
        verifyNever(() => repo.loadHistory());
        verifyNever(() => repo.startNewSession());
      },
    );

    // The fallback must be TODAY'S ChatStarted sequence, emit for emit.
    final List<ChatState> todaysOpen = <ChatState>[
      const ChatState(messages: <ChatMessage>[kChatOpeningMessage], initializing: false),
    ];

    blocTest<ChatBloc, ChatState>(
      'not a companion worker (null): exactly the ChatStarted sequence',
      build: () {
        when(() => repo.openCompanion()).thenAnswer((_) async => null);
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatCompanionStarted()),
      expect: () => todaysOpen,
      verify: (_) => verify(() => repo.ensureSession()).called(1),
    );

    blocTest<ChatBloc, ChatState>(
      'a throwing repository (even an Error) falls back to the ChatStarted sequence',
      build: () {
        when(() => repo.openCompanion()).thenThrow(StateError('boom'));
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatCompanionStarted()),
      expect: () => todaysOpen,
    );

    blocTest<ChatBloc, ChatState>(
      'an UNSTUBBED openCompanion (a test double that predates it) falls back too',
      build: () => ChatBloc(repo),
      act: (ChatBloc b) => b.add(const ChatCompanionStarted()),
      expect: () => todaysOpen,
    );
  });

  group('sending in companion mode', () {
    ChatBloc companionBloc() {
      when(() => repo.openCompanion())
          .thenAnswer((_) async => _companion(_recap, digestKey: 'k1'));
      return ChatBloc(repo);
    }

    test('a message goes to the companion, never down the interview path', () async {
      when(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _companion('Kisi job par dabakar poori jaankari dekhein.'));
      final ChatBloc bloc = companionBloc()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('naye jobs dikhao'));
      await pumpEventQueue();

      expect(bloc.state.messages.last.text, 'Kisi job par dabakar poori jaankari dekhein.');
      expect(bloc.state.companion, isTrue);
      verify(() => repo.sendCompanionMessage('naye jobs dikhao',
          submissionId: any(named: 'submissionId'))).called(1);
      verifyNever(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')));
      await bloc.close();
    });

    test('a 409 (no longer a companion worker) resends the SAME text down today\'s chat and leaves companion mode', () async {
      when(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => null);
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'Aap kya karna chahte hain.'));
      final ChatBloc bloc = companionBloc()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('hi'));
      await pumpEventQueue();

      final String? companionId = verify(() => repo.sendCompanionMessage('hi',
          submissionId: captureAny(named: 'submissionId'))).captured.single as String?;
      final String? interviewId = verify(() => repo.sendMessage('hi',
          submissionId: captureAny(named: 'submissionId'))).captured.single as String?;
      expect(bloc.state.companion, isFalse);
      expect(bloc.state.messages.last.text, 'Aap kya karna chahte hain.');
      // ONE worker bubble for the one message, delivered — not a failed one plus a resent copy.
      final List<ChatMessage> mine = bloc.state.messages.where((ChatMessage m) => m.fromWorker).toList();
      expect(mine.map((ChatMessage m) => m.text), <String>['hi']);
      expect(mine.single.status, ChatSendStatus.sent);
      // The resend is the SAME submission, so a server that saw both dedupes them.
      expect(interviewId, companionId);
      await bloc.close();
    });

    test('a companion answer is NOT an interview ask — no profiling_answer_spoken (#1316)', () async {
      final List<BbAnalyticsEvent> events = <BbAnalyticsEvent>[];
      when(() => repo.openCompanion()).thenAnswer((_) async => _companion(_recap));
      when(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _companion('Ok.'));
      final ChatBloc bloc = ChatBloc(repo, analyticsSink: events.add)
        ..add(const ChatCompanionStarted());
      await pumpEventQueue();
      bloc
        ..add(const ChatMessageSent('naye jobs'))
        ..add(const ChatMessageSent('applications'));
      await pumpEventQueue();

      expect(events.where((BbAnalyticsEvent e) => e.name == 'profiling_answer_spoken'), isEmpty);
      await bloc.close();
    });

    test('a failed companion send marks the bubble failed; the retry goes to the companion again', () async {
      int calls = 0;
      when(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const NetworkFailure();
        return _companion('Ok.');
      });
      final ChatBloc bloc = companionBloc()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('hi'));
      await pumpEventQueue();
      final int failed = bloc.state.messages.indexWhere(
          (ChatMessage m) => m.fromWorker && m.status == ChatSendStatus.failed);
      expect(failed, isNonNegative);

      bloc.add(ChatRetryRequested(failed));
      await pumpEventQueue();
      expect(calls, 2);
      expect(bloc.state.companion, isTrue);
      verifyNever(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')));
      await bloc.close();
    });

    test('"Chat se resume banayein" leaves companion mode for a fresh interview', () async {
      when(() => repo.startNewSession()).thenAnswer((_) async => null as ChatSessionOpening?);
      final ChatBloc bloc = companionBloc()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.companion, isTrue);
      bloc.add(const ChatSessionRestarted());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);
      verify(() => repo.startNewSession()).called(1);
      await bloc.close();
    });
  });

  group('ChatCompanionRefreshRequested', () {
    late DateTime now;
    ChatBloc bloc0() => ChatBloc(repo, clock: () => now);

    setUp(() => now = DateTime.utc(2026, 9, 26, 10));

    test('unchanged facts (same digest_key) add nothing', () async {
      when(() => repo.openCompanion())
          .thenAnswer((_) async => _companion(_recap, digestKey: 'same'));
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      now = now.add(const Duration(minutes: 5));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(bloc.state.messages, hasLength(1));
      verify(() => repo.openCompanion()).called(2);
      await bloc.close();
    });

    test('a FORCED refresh ignores the throttle; an unforced one obeys it', () async {
      // #1747 — the throttle is for refocus taps. A return from the companion's
      // own job detail is one deliberate trip, and "jobs applied to" is the
      // fact the recap leads with, so it must not wait out the minute.
      int n = 0;
      when(() => repo.openCompanion()).thenAnswer((_) async {
        n++;
        return _companion(_recap, digestKey: 'k$n');
      });
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(n, 1);

      // Inside the window, unforced: dropped.
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(n, 1);

      // Inside the same window, forced: read.
      bloc.add(const ChatCompanionRefreshRequested(force: true));
      await pumpEventQueue();
      expect(n, 2);
      await bloc.close();
    });

    test('changed facts append ONE new recap bubble and replace the chips', () async {
      const List<ChatOption> newChips = <ChatOption>[
        ChatOption(optionKey: 'companion_applied', labelText: 'Apni applications dekhein'),
      ];
      int n = 0;
      when(() => repo.openCompanion()).thenAnswer((_) async {
        n++;
        if (n == 1) return _companion(_recap, digestKey: 'k1');
        return ChatTurn(
          reply: 'Aapne ab tak 3 jobs par apply kiya hai.',
          followups: const <String>['Apni applications dekhein'],
          suggestedOptions: newChips,
          questionKind: ChatQuestionKind.disambiguate,
          companion: true,
          digestKey: 'k2',
        );
      });
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.suggestedOptions, _recapOptions);
      now = now.add(const Duration(minutes: 5));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(bloc.state.messages.map((ChatMessage m) => m.text).toList(),
          <String>[_recap, 'Aapne ab tak 3 jobs par apply kiya hai.']);
      expect(bloc.state.suggestedOptions, newChips);
      expect(bloc.state.followups, <String>['Apni applications dekhein']);
      await bloc.close();
    });

    test('a send that lands WHILE the refresh is reading keeps its answer and its chips', () async {
      // Review of PR #1746: handlers run concurrently, so a companion send can start and
      // finish inside the refresh's await. The recap must not bury that answer.
      const List<ChatOption> jobChips = <ChatOption>[
        ChatOption(optionKey: 'companion_job:11111111-1111-4111-8111-111111111111', labelText: 'CNC Operator — Pune'),
        ChatOption(optionKey: 'companion_jobs_tab', labelText: 'Sabhi jobs dekhein'),
      ];
      final Completer<ChatTurn?> slowRead = Completer<ChatTurn?>();
      int reads = 0;
      when(() => repo.openCompanion()).thenAnswer((_) {
        reads++;
        return reads == 1 ? Future<ChatTurn?>.value(_companion(_recap, digestKey: 'k1')) : slowRead.future;
      });
      when(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer(
        (_) async => ChatTurn(
          reply: 'Kisi job par dabakar poori jaankari dekhein.',
          followups: <String>[for (final ChatOption o in jobChips) o.labelText],
          suggestedOptions: jobChips,
          questionKind: ChatQuestionKind.disambiguate,
          companion: true,
        ),
      );
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();

      now = now.add(const Duration(minutes: 5));
      bloc.add(const ChatCompanionRefreshRequested()); // the GET is now in flight
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('naye jobs dikhao')); // ...and the POST lands first
      await pumpEventQueue();
      expect(bloc.state.messages.last.text, 'Kisi job par dabakar poori jaankari dekhein.');

      slowRead.complete(_companion('Aapne ab tak 3 jobs par apply kiya hai.', digestKey: 'k2'));
      await pumpEventQueue();

      expect(bloc.state.messages.last.text, 'Kisi job par dabakar poori jaankari dekhein.');
      expect(bloc.state.messages.map((ChatMessage m) => m.text), isNot(contains('Aapne ab tak 3 jobs par apply kiya hai.')));
      expect(bloc.state.suggestedOptions, jobChips);
      await bloc.close();
    });

    test('a recap with no digest key is never re-announced on refocus', () async {
      when(() => repo.openCompanion()).thenAnswer((_) async => _companion(_recap));
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      for (int i = 0; i < 3; i++) {
        now = now.add(const Duration(minutes: 5));
        bloc.add(const ChatCompanionRefreshRequested());
        await pumpEventQueue();
      }
      expect(bloc.state.messages, hasLength(1));
      await bloc.close();
    });

    test('is throttled — a refocus within a minute makes no request', () async {
      when(() => repo.openCompanion())
          .thenAnswer((_) async => _companion(_recap, digestKey: 'k'));
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      now = now.add(const Duration(seconds: 20));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      verify(() => repo.openCompanion()).called(1);
      await bloc.close();
    });

    test('never pulls an INTERVIEW into the companion', () async {
      when(() => repo.openCompanion()).thenAnswer((_) async => null);
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);
      when(() => repo.openCompanion())
          .thenAnswer((_) async => _companion(_recap, digestKey: 'k'));
      now = now.add(const Duration(minutes: 5));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);
      expect(bloc.state.messages.map((ChatMessage m) => m.text), isNot(contains(_recap)));
      // Not even asked: an interview tab makes no companion request on refocus.
      verify(() => repo.openCompanion()).called(1);
      await bloc.close();
    });
  });
}

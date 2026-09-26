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
            .thenAnswer((_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap, digestKey: 'k1')));
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
        when(() => repo.openCompanion())
          .thenAnswer((_) async => const CompanionOpening.interview());
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatCompanionStarted()),
      expect: () => todaysOpen,
      verify: (_) => verify(() => repo.ensureSession()).called(1),
    );

    // #1750 — A THROW IS NOT A VERDICT. It used to run the ChatStarted sequence,
    // which minted an EMPTY interview session the server's policy then read as
    // "this worker is interviewing" for six or seven hours. Nothing may be minted
    // on a read that did not come back.
    test('a throwing repository mints NOTHING and offers a retry', () async {
      when(() => repo.openCompanion()).thenThrow(StateError('boom'));
      final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.companionUnreachable, isTrue);
      expect(bloc.state.companion, isFalse);
      expect(bloc.state.initializing, isFalse);
      verifyNever(() => repo.ensureSession());
      verifyNever(() => repo.startNewSession());
      await bloc.close();
    });

    test('an UNSTUBBED openCompanion (a double that predates it) mints nothing either',
        () async {
      final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.companionUnreachable, isTrue);
      verifyNever(() => repo.ensureSession());
      await bloc.close();
    });

    test('after an unreachable open, a refresh RETRIES and enters companion mode',
        () async {
      int n = 0;
      when(() => repo.openCompanion()).thenAnswer((_) async {
        n++;
        if (n == 1) return const CompanionOpening.unreachable();
        return CompanionOpening(
          CompanionOpenOutcome.companion,
          _companion(_recap, digestKey: 'k1'),
        );
      });
      final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.companionUnreachable, isTrue);

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(bloc.state.companion, isTrue);
      expect(bloc.state.companionUnreachable, isFalse);
      expect(bloc.state.messages.single.text, _recap);
      verifyNever(() => repo.ensureSession());
      await bloc.close();
    });

    // A REAL `interview` answer still runs exactly today's sequence.
    blocTest<ChatBloc, ChatState>(
      'a real interview answer runs the unchanged ChatStarted sequence',
      build: () {
        when(() => repo.openCompanion())
            .thenAnswer((_) async => const CompanionOpening.interview());
        return ChatBloc(repo);
      },
      act: (ChatBloc b) => b.add(const ChatCompanionStarted()),
      expect: () => todaysOpen,
    );
  });

  group('sending in companion mode', () {
    ChatBloc companionBloc() {
      when(() => repo.openCompanion())
          .thenAnswer((_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap, digestKey: 'k1')));
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

    // #1751 — A 409 OPENS THE INTERVIEW; IT DOES NOT POST. The old behaviour
    // re-sent the same text through `sendMessage`, which calls `ensureSession()`
    // lazily and DISCARDS the opening — so an upload-road worker got a fresh
    // interview minted, its opener (a résumé confirm with Haan/Nahi) thrown away,
    // and the chip's own label posted as his first answer into the transcript
    // that feeds extraction.
    test('a 409 leaves companion mode, renders the opener, and posts NOTHING',
        () async {
      when(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => null);
      when(() => repo.ensureSession()).thenAnswer(
        (_) async => const ChatSessionOpening(text: 'Aap kya karna chahte hain.'),
      );
      final ChatBloc bloc = companionBloc()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('Naye jobs dekhein'));
      await pumpEventQueue();

      expect(bloc.state.companion, isFalse);
      verifyNever(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')));
      // His text is still his, and still unsent, so he can send it deliberately.
      final List<ChatMessage> mine =
          bloc.state.messages.where((ChatMessage m) => m.fromWorker).toList();
      expect(mine.map((ChatMessage m) => m.text), <String>['Naye jobs dekhein']);
      expect(mine.single.status, ChatSendStatus.failed);
      await bloc.close();
    });

    test('a companion answer is NOT an interview ask — no profiling_answer_spoken (#1316)', () async {
      final List<BbAnalyticsEvent> events = <BbAnalyticsEvent>[];
      when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap)));
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
          .thenAnswer((_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap, digestKey: 'same')));
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
        return CompanionOpening(
          CompanionOpenOutcome.companion,
          _companion(_recap, digestKey: 'k$n'),
        );
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
        if (n == 1) {
          return CompanionOpening(
            CompanionOpenOutcome.companion,
            _companion(_recap, digestKey: 'k1'),
          );
        }
        return CompanionOpening(
          CompanionOpenOutcome.companion,
          ChatTurn(
          reply: 'Aapne ab tak 3 jobs par apply kiya hai.',
          followups: const <String>['Apni applications dekhein'],
          suggestedOptions: newChips,
          questionKind: ChatQuestionKind.disambiguate,
            companion: true,
            digestKey: 'k2',
          ),
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
      final Completer<CompanionOpening> slowRead = Completer<CompanionOpening>();
      int reads = 0;
      when(() => repo.openCompanion()).thenAnswer((_) {
        reads++;
        return reads == 1
            ? Future<CompanionOpening>.value(CompanionOpening(
                CompanionOpenOutcome.companion,
                _companion(_recap, digestKey: 'k1'),
              ))
            : slowRead.future;
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

      slowRead.complete(CompanionOpening(
        CompanionOpenOutcome.companion,
        _companion('Aapne ab tak 3 jobs par apply kiya hai.', digestKey: 'k2'),
      ));
      await pumpEventQueue();

      expect(bloc.state.messages.last.text, 'Kisi job par dabakar poori jaankari dekhein.');
      expect(bloc.state.messages.map((ChatMessage m) => m.text), isNot(contains('Aapne ab tak 3 jobs par apply kiya hai.')));
      expect(bloc.state.suggestedOptions, jobChips);
      await bloc.close();
    });

    test('a recap with no digest key is never re-announced on refocus', () async {
      when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap)));
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
          .thenAnswer((_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap, digestKey: 'k')));
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      now = now.add(const Duration(seconds: 20));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      verify(() => repo.openCompanion()).called(1);
      await bloc.close();
    });

    test('never pulls an INTERVIEW into the companion', () async {
      when(() => repo.openCompanion())
          .thenAnswer((_) async => const CompanionOpening.interview());
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);
      when(() => repo.openCompanion())
          .thenAnswer((_) async => CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap, digestKey: 'k')));
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

  // ── #1753 — counts-only analytics, and the #1751 index offset ─────────────
  group('companion analytics', () {
    test('a companion open records exactly one companion_opened; a fallback none',
        () async {
      final List<BbAnalyticsEvent> events = <BbAnalyticsEvent>[];
      when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(
            CompanionOpenOutcome.companion,
            _companion(_recap, digestKey: 'k1'),
          ));
      final ChatBloc bloc = ChatBloc(repo, analyticsSink: events.add)
        ..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(events.where((BbAnalyticsEvent e) => e.name == 'companion_opened'),
          hasLength(1));
      await bloc.close();

      // A real interview answer records none.
      events.clear();
      when(() => repo.openCompanion())
          .thenAnswer((_) async => const CompanionOpening.interview());
      final ChatBloc plain = ChatBloc(repo, analyticsSink: events.add)
        ..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(events.where((BbAnalyticsEvent e) => e.name == 'companion_opened'),
          isEmpty);
      await plain.close();
    });

    test('a chip tap records its CLASS and never the key or the posting id',
        () async {
      final List<BbAnalyticsEvent> events = <BbAnalyticsEvent>[];
      when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(
            CompanionOpenOutcome.companion,
            _companion(_recap, digestKey: 'k1'),
          ));
      final ChatBloc bloc = ChatBloc(repo, analyticsSink: events.add)
        ..add(const ChatCompanionStarted());
      await pumpEventQueue();
      bloc.add(const ChatCompanionChipTapped('job', openedJob: true));
      await pumpEventQueue();

      final List<BbAnalyticsEvent> tapped = events
          .where((BbAnalyticsEvent e) => e.name == 'companion_chip_tapped')
          .toList();
      expect(tapped, hasLength(1));
      expect(tapped.single.parameters, <String, Object>{'key_class': 'job'});
      expect(events.where((BbAnalyticsEvent e) => e.name == 'companion_job_opened'),
          hasLength(1));
      // Nothing anywhere carries a uuid.
      for (final BbAnalyticsEvent e in events) {
        for (final Object v in e.parameters.values) {
          expect(v.toString(), isNot(contains('-')));
        }
      }
      await bloc.close();
    });

    test('#1751 — after a 409 the first interview answer is question_index 1',
        () async {
      final List<BbAnalyticsEvent> events = <BbAnalyticsEvent>[];
      when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(
            CompanionOpenOutcome.companion,
            _companion(_recap, digestKey: 'k1'),
          ));
      // Two companion messages, then the 409.
      int sends = 0;
      when(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async {
        sends++;
        return sends < 3 ? _companion('Ok.') : null;
      });
      when(() => repo.ensureSession()).thenAnswer(
        (_) async => const ChatSessionOpening(text: 'Aap kya karna chahte hain.'),
      );
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'Theek hai.'));
      final ChatBloc bloc = ChatBloc(repo, analyticsSink: events.add)
        ..add(const ChatCompanionStarted());
      await pumpEventQueue();
      bloc
        ..add(const ChatMessageSent('naye jobs'))
        ..add(const ChatMessageSent('applications'));
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('Resume badlein')); // the 409
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);

      // The first REAL interview answer.
      bloc.add(const ChatMessageSent('Fitter ka kaam'));
      await pumpEventQueue();

      final List<BbAnalyticsEvent> spoken = events
          .where((BbAnalyticsEvent e) => e.name == 'profiling_answer_spoken')
          .toList();
      expect(spoken, hasLength(1));
      // 1, not 4: the three companion bubbles are not interview asks.
      expect(spoken.single.parameters['question_index'], 1);
      await bloc.close();
    });
  });
}

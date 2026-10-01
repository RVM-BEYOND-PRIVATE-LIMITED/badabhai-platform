import 'dart:async';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatOption, ChatQuestionKind, EditProposal, EditProposalRow;
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

  });

  // ── A TAB THAT OPENED AS THE INTERVIEW, on refocus ──────────────────────────
  // The tab picks its chat when it opens and used to never ask again, so a tab
  // that opened as the interview kept the old transcript until the app was
  // killed — after the worker confirmed, and whenever the Remote Config switch
  // landed after the tab opened. The server decides it again on refocus, unless
  // the worker is taking part in that interview on this screen.
  group('ChatCompanionRefreshRequested on an INTERVIEW tab', () {
    late DateTime now;
    ChatBloc bloc0() => ChatBloc(repo, clock: () => now);

    const List<ChatMessage> oldTranscript = <ChatMessage>[
      ChatMessage(text: 'Aap aur kaun sa kaam karte hain?', fromWorker: false),
      ChatMessage(text: 'welding', fromWorker: true),
      ChatMessage(text: 'Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.', fromWorker: false),
    ];

    void serverSays(CompanionOpening answer) =>
        when(() => repo.openCompanion()).thenAnswer((_) async => answer);

    CompanionOpening recap() =>
        CompanionOpening(CompanionOpenOutcome.companion, _companion(_recap, digestKey: 'k1'));

    setUp(() {
      now = DateTime.utc(2026, 9, 28, 5, 31);
      when(() => repo.loadHistory()).thenAnswer((_) async => oldTranscript);
      when(() => repo.forgetSession()).thenReturn(null);
    });

    test('opened with the switch OFF, a refocus moves a REDRAWN transcript to the recap', () async {
      serverSays(recap());
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);
      expect(bloc.state.messages, hasLength(1 + oldTranscript.length));

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isTrue);
      // The recap stands alone: no canned opener, no old transcript (ADR-0044 R4).
      expect(bloc.state.messages.map((ChatMessage m) => m.text).toList(), <String>[_recap]);
      expect(bloc.state.messages.single.ttsText, 'नमस्ते।');
      expect(bloc.state.suggestedOptions, _recapOptions);
      expect(bloc.state.questionKind, ChatQuestionKind.disambiguate);
      expect(bloc.state.initializing, isFalse);
      verify(() => repo.openCompanion()).called(1);
      // As if it had opened on the recap: the old interview's id is not kept.
      verify(() => repo.forgetSession()).called(1);
      await bloc.close();
    });

    test('opened as the interview by the SERVER, a refocus asks again and moves to the recap', () async {
      serverSays(const CompanionOpening.interview());
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);

      // The worker confirmed their profile elsewhere; the server's answer changed.
      serverSays(recap());
      now = now.add(const Duration(seconds: 5));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isTrue);
      expect(bloc.state.messages.map((ChatMessage m) => m.text).toList(), <String>[_recap]);
      verify(() => repo.openCompanion()).called(2);
      await bloc.close();
    });

    test('an "interview" answer on refocus keeps the transcript exactly as it was', () async {
      serverSays(const CompanionOpening.interview());
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();
      final ChatState before = bloc.state;

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state, before);
      verify(() => repo.openCompanion()).called(1);
      verifyNever(() => repo.forgetSession());
      await bloc.close();
    });

    test('an unreachable or throwing read keeps the transcript and shows no retry card', () async {
      serverSays(const CompanionOpening.unreachable());
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();
      final ChatState before = bloc.state;

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(bloc.state, before);

      when(() => repo.openCompanion()).thenThrow(StateError('boom'));
      now = now.add(const Duration(minutes: 2));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(bloc.state, before);
      expect(bloc.state.companionUnreachable, isFalse);
      verify(() => repo.openCompanion()).called(2);
      await bloc.close();
    });

    // After a redo closes, a returning worker keeps his confirmed profile until he
    // opens the preview, so the SERVER already says "companion" — only the tab
    // knows the redo's "build my profile" button is still his to tap.
    test('a worker whose LIVE interview closed in this tab keeps it: the server is not even asked', () async {
      serverSays(recap());
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(
                reply: 'Aapki baat poori ho chuki hai. Profile taiyaar ho rahi hai.',
                followups: <String>[],
                extractionReady: true,
                sessionEnded: true,
              ));
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('welding'));
      await pumpEventQueue();
      expect(bloc.state.extractionReady, isTrue);

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isFalse);
      expect(bloc.state.messages.last.text, contains('poori ho chuki'));
      verifyNever(() => repo.openCompanion());
      await bloc.close();
    });

    test('a FAILED answer counts too: the worker is still in that interview', () async {
      serverSays(recap());
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenThrow(const NetworkFailure());
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('welding'));
      await pumpEventQueue();

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isFalse);
      verifyNever(() => repo.openCompanion());
      await bloc.close();
    });

    test('a settled "Haan" to the résumé update may leave it, and the interview\'s latches go with it', () async {
      serverSays(recap());
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(
                reply: 'Theek hai, aapka resume update ho raha hai.',
                followups: <String>[],
                extractionReady: true,
                resumeUpdate: 'queued',
              ));
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('Haan'));
      await pumpEventQueue();
      expect(bloc.state.resumeUpdateQueued, isTrue);

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isTrue);
      expect(bloc.state.messages.map((ChatMessage m) => m.text).toList(), <String>[_recap]);
      expect(bloc.state.extractionReady, isFalse);
      expect(bloc.state.resumeUpdateQueued, isFalse);
      await bloc.close();
    });

    test('a send that starts while the read is out keeps the interview', () async {
      final Completer<CompanionOpening> read = Completer<CompanionOpening>();
      when(() => repo.openCompanion()).thenAnswer((_) => read.future);
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'Kitne saal ka tajurba hai?', followups: <String>[]));
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('welding'));
      await pumpEventQueue();
      read.complete(recap());
      await pumpEventQueue();

      expect(bloc.state.companion, isFalse);
      expect(bloc.state.messages.last.text, 'Kitne saal ka tajurba hai?');
      await bloc.close();
    });

    // The production symptom: the tab redrew the worker's OLD, finished
    // interview; he typed into it and got the stateless résumé menu. That reply
    // comes from a session that was already over — nothing of his to finish.
    test('a reply from the ENDED session it redrew (the résumé menu) does not hold the tab', () async {
      serverSays(recap());
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(
                reply: 'Aap resume mein kya badalna chahte hain?',
                followups: <String>['Apna resume edit karein'],
                extractionReady: true,
                isMock: true,
                sessionEnded: true,
              ));
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('hi'));
      await pumpEventQueue();
      expect(bloc.state.extractionReady, isTrue);

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isTrue);
      expect(bloc.state.messages.map((ChatMessage m) => m.text).toList(), <String>[_recap]);
      expect(bloc.state.extractionReady, isFalse);
      await bloc.close();
    });

    test('a DEGRADED reply from a live session still holds it (the worker retries into it)', () async {
      serverSays(recap());
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(
                reply: 'Abhi thodi dikkat aa rahi hai.',
                followups: <String>[],
                isMock: true,
              ));
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('welding'));
      await pumpEventQueue();

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isFalse);
      verifyNever(() => repo.openCompanion());
      await bloc.close();
    });

    test('a redo the worker asked for ("Chat se resume banayein") is never pulled back to the recap', () async {
      serverSays(recap());
      when(() => repo.startNewSession()).thenAnswer((_) async => null);
      final ChatBloc bloc = bloc0()..add(const ChatSessionRestarted());
      await pumpEventQueue();
      expect(bloc.state.initializing, isFalse);

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isFalse);
      verifyNever(() => repo.openCompanion());
      await bloc.close();
    });

    test('a refocus while the transcript is still loading asks nothing, and the redraw never lands under a recap', () async {
      serverSays(recap());
      final Completer<List<ChatMessage>> history = Completer<List<ChatMessage>>();
      when(() => repo.loadHistory()).thenAnswer((_) => history.future);
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();
      expect(bloc.state.initializing, isFalse);

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      verifyNever(() => repo.openCompanion());

      history.complete(oldTranscript);
      await pumpEventQueue();
      expect(bloc.state.messages, hasLength(1 + oldTranscript.length));

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(bloc.state.companion, isTrue);
      expect(bloc.state.messages.map((ChatMessage m) => m.text).toList(), <String>[_recap]);
      await bloc.close();
    });

    test('after a "Haan" switch, the failed bubble a 409 fallback leaves holds the interview for its retry', () async {
      serverSays(recap());
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(
                reply: 'Theek hai, aapka resume update ho raha hai.',
                followups: <String>[],
                sessionEnded: true,
                resumeUpdate: 'queued',
              ));
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('Haan'));
      await pumpEventQueue();
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(bloc.state.companion, isTrue);

      // A companion send is refused (409): the tab falls back to the interview,
      // leaving that text as a failed bubble for the worker to retry.
      when(() => repo.sendCompanionMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => null);
      bloc.add(const ChatMessageSent('naye jobs'));
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);

      // The failed bubble holds the tab: it is the worker's to retry.
      now = now.add(const Duration(minutes: 2));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(bloc.state.companion, isFalse);
      verify(() => repo.openCompanion()).called(1);
      await bloc.close();
    });

    test('an unreachable open whose retry says "interview" stops retrying: the interview-tab rule takes over', () async {
      serverSays(const CompanionOpening.unreachable());
      final ChatBloc bloc = bloc0()..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.companionUnreachable, isTrue);

      serverSays(const CompanionOpening.interview());
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      expect(bloc.state.companionUnreachable, isFalse);
      verify(() => repo.ensureSession()).called(1);
      verify(() => repo.openCompanion()).called(2);

      // The worker answers the interview; the server would now say companion.
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'Kitne saal ka tajurba hai?'));
      bloc.add(const ChatMessageSent('welding'));
      await pumpEventQueue();
      serverSays(recap());
      now = now.add(const Duration(minutes: 2));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();

      expect(bloc.state.companion, isFalse);
      expect(bloc.state.messages.last.text, 'Kitne saal ka tajurba hai?');
      verifyNever(() => repo.openCompanion());
      await bloc.close();
    });

    test('is throttled like the recap refresh — a second refocus within a minute asks nothing', () async {
      serverSays(const CompanionOpening.interview());
      final ChatBloc bloc = bloc0()..add(const ChatStarted());
      await pumpEventQueue();

      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      now = now.add(const Duration(seconds: 30));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
      verify(() => repo.openCompanion()).called(1);

      now = now.add(const Duration(seconds: 31));
      bloc.add(const ChatCompanionRefreshRequested());
      await pumpEventQueue();
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

  // ── ADR-0046 §5.1/§5.2 — THE EDIT CARD ─────────────────────────────────────
  //
  // A card arrives on a companion turn (`edit_proposal`); Haan POSTs the ticked
  // rows' ids to the confirm route, Nahi POSTs the cancel route. Both answers
  // are TURNS, and the failure shapes are DISTINCT: a gone proposal (404) stays
  // in the companion and re-reads the recap; a stale proposal (409
  // `{reason:"stale", turn}`) shows the server's own reviewed line as a normal
  // bubble; a 409 `{mode:"interview"}` leaves companion mode for the interview.
  group('ADR-0046 edit card', () {
    const String proposalId = '22222222-2222-4222-8222-222222222222';
    const String rowA = '33333333-3333-4333-8333-333333333333';
    const String rowB = '44444444-4444-4444-8444-444444444444';

    EditProposal proposal() => EditProposal(
          proposalId: proposalId,
          expiresAt: DateTime.now().add(const Duration(minutes: 10)),
          rows: const <EditProposalRow>[
            EditProposalRow(
              rowId: rowA,
              sectionLabel: 'Skills',
              op: 'add',
              after: 'Welding',
            ),
            EditProposalRow(
              rowId: rowB,
              sectionLabel: 'Languages',
              op: 'delete',
              before: 'Hindi',
            ),
          ],
        );

    ChatTurn cardTurn() => ChatTurn(
          reply: 'Yeh badlav karne hain?',
          suggestedOptions: const <ChatOption>[],
          questionKind: ChatQuestionKind.disambiguate,
          companion: true,
          editProposal: proposal(),
        );

    /// A bloc already in companion mode whose LAST turn carries the card.
    Future<ChatBloc> blocWithCard() async {
      when(() => repo.openCompanion()).thenAnswer(
        (_) async => CompanionOpening(
          CompanionOpenOutcome.companion,
          _companion(_recap, digestKey: 'k1'),
        ),
      );
      when(() => repo.sendCompanionMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => cardTurn());
      final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
      await pumpEventQueue();
      bloc.add(const ChatMessageSent('Resume badlo'));
      await pumpEventQueue();
      expect(bloc.state.editProposal, isNotNull);
      return bloc;
    }

    test('Haan sends the TICKED row ids and renders the served turn', () async {
      final ChatBloc bloc = await blocWithCard();
      when(() => repo.confirmCompanionEdit(proposalId, <String>[rowA],
              submissionId: any(named: 'submissionId'))).thenAnswer(
        (_) async => CompanionEditResult.served(
          const ChatTurn(
            reply: 'Badlav ho gaya. Aapka resume update ho raha hai.',
            companion: true,
          ),
        ),
      );

      bloc.add(const ChatEditProposalConfirmed(<String>[rowA]));
      await pumpEventQueue();

      expect(bloc.state.editProposal, isNull);
      expect(bloc.state.messages.last.text, contains('Badlav ho gaya'));
      verify(() => repo.confirmCompanionEdit(proposalId, <String>[rowA],
          submissionId: any(named: 'submissionId'))).called(1);
      await bloc.close();
    });

    test('Nahi cancels and renders the served turn', () async {
      final ChatBloc bloc = await blocWithCard();
      when(() => repo.cancelCompanionEdit(proposalId,
              submissionId: any(named: 'submissionId'))).thenAnswer(
        (_) async => CompanionEditResult.served(
          const ChatTurn(
            reply: 'Theek hai, kuch nahi badla.',
            companion: true,
          ),
        ),
      );

      bloc.add(const ChatEditProposalCancelled());
      await pumpEventQueue();

      expect(bloc.state.editProposal, isNull);
      expect(bloc.state.messages.last.text, contains('kuch nahi badla'));
      expect(bloc.state.companion, isTrue);
      await bloc.close();
    });

    test('a GONE proposal clears the card and re-reads the recap, staying in companion', () async {
      final ChatBloc bloc = await blocWithCard();
      when(() => repo.confirmCompanionEdit(any(), any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const CompanionEditResult.gone());

      bloc.add(const ChatEditProposalConfirmed(<String>[rowA, rowB]));
      await pumpEventQueue();

      expect(bloc.state.editProposal, isNull);
      expect(bloc.state.companion, isTrue);
      // The forced refresh re-read the recap (one read on open + one here).
      verify(() => repo.openCompanion()).called(2);
      await bloc.close();
    });

    test('a STALE confirm shows the server\'s line as a bubble, not the gone notice', () async {
      final ChatBloc bloc = await blocWithCard();
      when(() => repo.confirmCompanionEdit(any(), any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => CompanionEditResult.stale(
                const ChatTurn(
                  reply: 'Profile beech mein badal gaya. Dobara bataiye.',
                  ttsText: 'प्रोफ़ाइल बीच में बदल गया।',
                  companion: true,
                ),
              ));

      bloc.add(const ChatEditProposalConfirmed(<String>[rowA]));
      await pumpEventQueue();

      // The card is dead (the profile moved under it) and goes...
      expect(bloc.state.editProposal, isNull);
      // ...and the server's own line renders as an ordinary Bada Bhai bubble,
      // read aloud from its reviewed Devanagari twin.
      expect(bloc.state.messages.last.text,
          contains('Profile beech mein badal gaya'));
      expect(bloc.state.messages.last.canReadAloud, isTrue);
      // NOT the 404 "card went away" snackbar — the server already explained.
      expect(bloc.state.editNotice, isNull);
      expect(bloc.state.companion, isTrue);
      await bloc.close();
    });

    test('a 409 mode:interview leaves companion mode and opens the interview', () async {
      final ChatBloc bloc = await blocWithCard();
      when(() => repo.confirmCompanionEdit(any(), any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const CompanionEditResult.interview());
      when(() => repo.ensureSession()).thenAnswer(
        (_) async => const ChatSessionOpening(text: 'Aap kya karna chahte hain.'),
      );

      bloc.add(const ChatEditProposalConfirmed(<String>[rowA]));
      await pumpEventQueue();

      expect(bloc.state.companion, isFalse);
      expect(bloc.state.editProposal, isNull);
      verify(() => repo.ensureSession()).called(1);
      await bloc.close();
    });

    test('a failed confirm KEEPS the card so the worker can retry', () async {
      final ChatBloc bloc = await blocWithCard();
      when(() => repo.confirmCompanionEdit(any(), any(),
              submissionId: any(named: 'submissionId')))
          .thenThrow(const NetworkFailure());

      bloc.add(const ChatEditProposalConfirmed(<String>[rowA]));
      await pumpEventQueue();

      expect(bloc.state.editProposal, isNotNull);
      expect(bloc.state.companion, isTrue);
      expect(bloc.state.sending, isFalse);
      await bloc.close();
    });

    test('a NOTHING-WRITTEN fallback turn hands the SAME card back', () async {
      final ChatBloc bloc = await blocWithCard();
      when(() => repo.confirmCompanionEdit(any(), any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => CompanionEditResult.served(
                ChatTurn(
                  reply: 'Abhi badlav nahi ho paaya, thodi der mein try karein.',
                  questionKind: ChatQuestionKind.disambiguate,
                  companion: true,
                  // The server wrote nothing, so it answers 200 with the
                  // FALLBACK turn CARRYING THE SAME proposal (contracts §5.2).
                  editProposal: proposal(),
                ),
              ));

      bloc.add(const ChatEditProposalConfirmed(<String>[rowA]));
      await pumpEventQueue();

      // The card is still on screen — same proposal, same rows — so the worker
      // can tap Haan again. It must not have been cleared by the served turn.
      expect(bloc.state.editProposal, isNotNull);
      expect(bloc.state.editProposal!.proposalId, proposalId);
      expect(
        bloc.state.editProposal!.rows.map((EditProposalRow r) => r.rowId),
        <String>[rowA, rowB],
      );
      expect(bloc.state.companion, isTrue);
      await bloc.close();
    });

    test('an empty tick set is a no-op — nothing is POSTed', () async {
      final ChatBloc bloc = await blocWithCard();
      bloc.add(const ChatEditProposalConfirmed(<String>[]));
      await pumpEventQueue();
      expect(bloc.state.editProposal, isNotNull);
      verifyNever(() => repo.confirmCompanionEdit(any(), any(),
          submissionId: any(named: 'submissionId')));
      await bloc.close();
    });
  });

  // ── ADR-0046 — THE v2 FIELDS REACH STATE FROM *EVERY* COMPANION PATH ───────
  //
  // A companion turn becomes state in five places. Two of them (the refocus
  // refresh and the interview→recap move) never learned about `edit_proposal`,
  // so a card served there was dropped — and, worse, a card already on screen
  // OUTLIVED the turn that should have replaced it, because a copyWith that
  // names nothing keeps the old value. All five now go through one projection;
  // these tests are what keeps a sixth from being written by hand.
  group('every companion path carries the v2 fields', () {
    EditProposal card(String id) => EditProposal(
          proposalId: id,
          expiresAt: DateTime.now().add(const Duration(minutes: 5)),
          rows: const <EditProposalRow>[
            EditProposalRow(
              rowId: 'r1',
              sectionLabel: 'Skills',
              op: 'add',
              after: 'Welding',
            ),
          ],
        );

    ChatTurn withCard(String reply, String id, {String? digestKey}) => ChatTurn(
          reply: reply,
          companion: true,
          digestKey: digestKey,
          editProposal: card(id),
        );

    test('the OPEN carries a card', () async {
      when(() => repo.openCompanion()).thenAnswer((_) async =>
          CompanionOpening(CompanionOpenOutcome.companion,
              withCard(_recap, 'p-open', digestKey: 'k1')));
      final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.editProposal?.proposalId, 'p-open');
      await bloc.close();
    });

    test('a REFOCUS REFRESH carries a card, and clears a stale one', () async {
      when(() => repo.openCompanion()).thenAnswer((_) async =>
          CompanionOpening(CompanionOpenOutcome.companion,
              withCard(_recap, 'p-first', digestKey: 'k1')));
      final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.editProposal?.proposalId, 'p-first');

      // A refresh whose turn carries a DIFFERENT card replaces it...
      when(() => repo.openCompanion()).thenAnswer((_) async =>
          CompanionOpening(CompanionOpenOutcome.companion,
              withCard('Naya recap.', 'p-second', digestKey: 'k2')));
      bloc.add(const ChatCompanionRefreshRequested(force: true));
      await pumpEventQueue();
      expect(bloc.state.editProposal?.proposalId, 'p-second',
          reason: 'the refresh dropped the card');

      // ...and a refresh whose turn carries NONE clears it, rather than leaving
      // a dead card the worker can still tap Haan on.
      when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(
          CompanionOpenOutcome.companion,
          _companion('Aur kuch?', digestKey: 'k3')));
      bloc.add(const ChatCompanionRefreshRequested(force: true));
      await pumpEventQueue();
      expect(bloc.state.editProposal, isNull,
          reason: 'a card outlived the turn that replaced it');
      await bloc.close();
    });
  });

  // ── #1821 F1 — THE COOL-DOWN IS STICKY ─────────────────────────────────────
  group('the cool-down survives the turns that follow it', () {
    test('a later turn without cooldown_until does NOT hand the composer back',
        () async {
      final DateTime until = DateTime.now().add(const Duration(minutes: 20));
      when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(
            CompanionOpenOutcome.companion,
            ChatTurn(
              reply: 'Thodi der ruk jaayein.',
              companion: true,
              digestKey: 'k1',
              cooldownUntil: until,
            ),
          ));
      // The server sends `cooldown_until` ONLY on the turn that starts the wait.
      when(() => repo.sendCompanionMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _companion('Theek hai.'));

      final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
      await pumpEventQueue();
      expect(bloc.state.cooldownUntil, until);

      // Tapping any chip posts a message; its reply omits the field.
      bloc.add(const ChatMessageSent('Naya resume'));
      await pumpEventQueue();

      expect(bloc.state.cooldownUntil, until,
          reason: 'a chip tap unlocked the composer while the server cool-down '
              'still had minutes to run — the next message would be refused');
      await bloc.close();
    });

    test('a cool-down whose instant has PASSED is dropped', () async {
      final DateTime past = DateTime.now().subtract(const Duration(minutes: 1));
      when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(
            CompanionOpenOutcome.companion,
            ChatTurn(
              reply: 'Thodi der ruk jaayein.',
              companion: true,
              digestKey: 'k1',
              cooldownUntil: past,
            ),
          ));
      when(() => repo.sendCompanionMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _companion('Theek hai.'));
      final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
      await pumpEventQueue();

      bloc.add(const ChatMessageSent('Naya resume'));
      await pumpEventQueue();
      expect(bloc.state.cooldownUntil, isNull,
          reason: 'an elapsed wait must not stay pinned forever');
      await bloc.close();
    });
  });

  // ── ADR-0046 O9 — the read-aloud guard on EVERY bot bubble ─────────────────
  test('a model-written turn never yields a speakable bubble, on any path',
      () async {
    when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(
          CompanionOpenOutcome.companion,
          const ChatTurn(
            reply: 'Welding mein NDT seekhein.',
            companion: true,
            digestKey: 'k1',
            readAloud: false,
          ),
        ));
    when(() => repo.sendCompanionMessage(any(),
            submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(
              reply: 'Uske baad supervisor.',
              companion: true,
              readAloud: false,
            ));
    final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
    await pumpEventQueue();
    expect(bloc.state.messages.last.canReadAloud, isFalse, reason: 'open');

    bloc.add(const ChatMessageSent('Career ki baat'));
    await pumpEventQueue();
    expect(bloc.state.messages.last.canReadAloud, isFalse, reason: 'reply');
    await bloc.close();
  });

  // ── #1862 — THE COOL-DOWN IS NOT THE EDIT CARD'S TO CLEAR ──────────────────
  test('a GONE card leaves the cool-down deadline standing', () async {
    final DateTime until = DateTime.now().add(const Duration(minutes: 20));
    when(() => repo.openCompanion()).thenAnswer((_) async => CompanionOpening(
          CompanionOpenOutcome.companion,
          ChatTurn(
            reply: 'Thodi der ruk jaayein.',
            companion: true,
            digestKey: 'k1',
            cooldownUntil: until,
            editProposal: EditProposal(
              proposalId: 'p1',
              expiresAt: DateTime.now().add(const Duration(minutes: 5)),
              rows: const <EditProposalRow>[
                EditProposalRow(
                  rowId: 'r1',
                  sectionLabel: 'Skills',
                  op: 'add',
                  after: 'Welding',
                ),
              ],
            ),
          ),
        ));
    // The card is dead; the server's faltu wait is not.
    when(() => repo.confirmCompanionEdit(any(), any()))
        .thenAnswer((_) async => const CompanionEditResult.gone());
    when(() => repo.sendCompanionMessage(any(),
            submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => _companion('Theek hai.'));

    final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
    await pumpEventQueue();
    expect(bloc.state.cooldownUntil, until);

    bloc.add(const ChatEditProposalConfirmed(<String>['r1']));
    await pumpEventQueue();

    expect(bloc.state.editProposal, isNull, reason: 'the dead card goes');
    expect(bloc.state.cooldownUntil, until,
        reason: 'a 404 on the card handed the composer back mid-wait — the '
            'card knows nothing about the faltu cool-down');
    await bloc.close();
  });

  // ── #1862 — A FAILED OR GONE EDIT ALWAYS SAYS SOMETHING ────────────────────
  group('the edit card never fails silently', () {
    ChatTurn withCard() => ChatTurn(
          reply: _recap,
          companion: true,
          digestKey: 'k1',
          editProposal: EditProposal(
            proposalId: 'p1',
            expiresAt: DateTime.now().add(const Duration(minutes: 5)),
            rows: const <EditProposalRow>[
              EditProposalRow(
                rowId: 'r1',
                sectionLabel: 'Skills',
                op: 'add',
                after: 'Welding',
              ),
            ],
          ),
        );

    Future<ChatBloc> opened() async {
      when(() => repo.openCompanion()).thenAnswer((_) async =>
          CompanionOpening(CompanionOpenOutcome.companion, withCard()));
      when(() => repo.sendCompanionMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => _companion('Theek hai.'));
      final ChatBloc bloc = ChatBloc(repo)..add(const ChatCompanionStarted());
      await pumpEventQueue();
      return bloc;
    }

    test('a GONE confirm explains why the card vanished', () async {
      when(() => repo.confirmCompanionEdit(any(), any()))
          .thenAnswer((_) async => const CompanionEditResult.gone());
      final ChatBloc bloc = await opened();
      bloc.add(const ChatEditProposalConfirmed(<String>['r1']));
      await pumpEventQueue();
      expect(bloc.state.editNotice, kCompanionEditGoneNotice);
      await bloc.close();
    });

    test('a FAILED confirm keeps the card and gives the real reason', () async {
      when(() => repo.confirmCompanionEdit(any(), any()))
          .thenThrow(const NetworkFailure());
      final ChatBloc bloc = await opened();
      bloc.add(const ChatEditProposalConfirmed(<String>['r1']));
      await pumpEventQueue();
      expect(bloc.state.editNotice, isNotNull);
      expect(bloc.state.editNotice, isNot(kCompanionEditGoneNotice));
      expect(bloc.state.editProposal, isNotNull,
          reason: 'nothing was applied, so re-tapping Haan is the retry');
      await bloc.close();
    });

    test('a FAILED cancel says so too', () async {
      when(() => repo.cancelCompanionEdit(any()))
          .thenThrow(const NetworkFailure());
      final ChatBloc bloc = await opened();
      bloc.add(const ChatEditProposalCancelled());
      await pumpEventQueue();
      expect(bloc.state.editNotice, isNotNull);
      expect(bloc.state.editProposal, isNotNull);
      await bloc.close();
    });
  });
}

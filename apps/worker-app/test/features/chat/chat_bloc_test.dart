import 'dart:async';

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show
        ChatInputMode,
        ChatOption,
        ChatProgress,
        ChatQuestionKind,
        PredictedQuestion;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

// The opener is now owned by the bloc (#422) — reference the exported
// constant so a copy change can never silently desync the tests from the app.
const ChatMessage _opening = kChatOpeningMessage;

/// A #870-tolerant [ChatState] matcher: asserts the transcript SHAPE
/// (text/fromWorker/status) plus [sending] and [followups], ignoring the random
/// per-submission id now minted onto a worker bubble — which a `const` expected
/// state cannot pin. Used only by the two exact-sequence blocTests below; every
/// other test either seeds its own bubbles or asserts the id directly.
Matcher _stateLike(
  List<(String, bool, ChatSendStatus)> transcript, {
  bool sending = false,
  List<String> followups = const <String>[],
}) {
  return isA<ChatState>()
      .having(
        (ChatState s) => s.messages
            .map((ChatMessage m) => (m.text, m.fromWorker, m.status))
            .toList(),
        'transcript',
        transcript,
      )
      .having((ChatState s) => s.sending, 'sending', sending)
      .having((ChatState s) => s.followups, 'followups', followups);
}

void main() {
  late MockChatRepository repo;
  setUp(() {
    repo = MockChatRepository();
    // Default: no persisted transcript to redraw (#502). Individual tests
    // override this to exercise hydration.
    when(() => repo.loadHistory())
        .thenAnswer((_) async => const <ChatMessage>[]);
  });

  blocTest<ChatBloc, ChatState>(
    'ChatStarted opens the session and drops the spinner',
    build: () {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      return ChatBloc(repo);
    },
    act: (ChatBloc b) => b.add(const ChatStarted()),
    expect: () => const <ChatState>[
      ChatState(messages: <ChatMessage>[_opening], initializing: false),
    ],
    verify: (_) => verify(() => repo.ensureSession()).called(1),
  );

  // #502 transcript hydration — a >5min re-lock rebuilds the bloc with only its
  // opener while the answers still live server-side. On open, the persisted
  // transcript is redrawn AFTER the opener bubble.
  blocTest<ChatBloc, ChatState>(
    'ChatStarted redraws the persisted transcript after the opener (#502)',
    build: () {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[
            ChatMessage(text: 'CNC operator hoon', fromWorker: true),
            ChatMessage(text: 'Badhiya! Kaunsa control?', fromWorker: false),
          ]);
      return ChatBloc(repo);
    },
    act: (ChatBloc b) => b.add(const ChatStarted()),
    // Two emits: the spinner drops FIRST (before any hydration await, so a
    // concurrent send is never reordered behind it), then the transcript is
    // redrawn as a follow-up.
    expect: () => const <ChatState>[
      ChatState(messages: <ChatMessage>[_opening], initializing: false),
      ChatState(
        messages: <ChatMessage>[
          _opening,
          ChatMessage(text: 'CNC operator hoon', fromWorker: true),
          ChatMessage(text: 'Badhiya! Kaunsa control?', fromWorker: false),
        ],
        initializing: false,
      ),
    ],
  );

  // De-dup guard: a worker who has ALREADY typed (the fast-typist race) must not
  // have their live bubbles clobbered by a redraw.
  blocTest<ChatBloc, ChatState>(
    'ChatStarted does NOT redraw when the worker has already typed',
    build: () {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[
            ChatMessage(text: 'stale server line', fromWorker: false),
          ]);
      return ChatBloc(repo);
    },
    seed: () => const ChatState(
      messages: <ChatMessage>[
        _opening,
        ChatMessage(text: 'cnc', fromWorker: true),
      ],
    ),
    act: (ChatBloc b) => b.add(const ChatStarted()),
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

  // #343 — the spinner still drops (the worker can type), but the failure is no
  // longer SWALLOWED: sessionFailed surfaces a banner, and the repository
  // re-opens the session on the next send.
  blocTest<ChatBloc, ChatState>(
    'ChatStarted drops the spinner AND surfaces a failed session-open',
    build: () {
      when(() => repo.ensureSession()).thenThrow(const NetworkFailure());
      return ChatBloc(repo);
    },
    act: (ChatBloc b) => b.add(const ChatStarted()),
    expect: () => const <ChatState>[
      ChatState(
        messages: <ChatMessage>[_opening],
        initializing: false,
        sessionFailed: true,
      ),
    ],
    verify: (_) => verify(() => repo.ensureSession()).called(1),
  );

  blocTest<ChatBloc, ChatState>(
    'ChatMessageSent appends the worker message, shows typing, then the reply + chips',
    build: () {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer((_) async =>
          const ChatTurn(reply: 'Got it.', followups: <String>['Haan', 'Nahi']));
      return ChatBloc(repo);
    },
    act: (ChatBloc b) {
      b.add(const ChatStarted());
      b.add(const ChatMessageSent('cnc'));
    },
    // #870-tolerant: the worker bubble now carries a random submission id, so the
    // sequence is asserted by SHAPE (see [_stateLike]).
    expect: () => <Matcher>[
      _stateLike(<(String, bool, ChatSendStatus)>[
        (_opening.text, false, ChatSendStatus.sent),
      ]),
      // Worker bubble appended + typing indicator on.
      _stateLike(<(String, bool, ChatSendStatus)>[
        (_opening.text, false, ChatSendStatus.sent),
        ('cnc', true, ChatSendStatus.sent),
      ], sending: true),
      // Reply appended, typing off, followup chips carried through.
      _stateLike(<(String, bool, ChatSendStatus)>[
        (_opening.text, false, ChatSendStatus.sent),
        ('cnc', true, ChatSendStatus.sent),
        ('Got it.', false, ChatSendStatus.sent),
      ], followups: <String>['Haan', 'Nahi']),
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
    verify: (_) => verifyNever(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))),
  );

  // #343 — this test used to assert the SILENT DROP as intended behaviour
  // ("frozen UI"), actively protecting the defect: an undelivered message stayed
  // rendered as if it had been sent. It now asserts the opposite — the bubble is
  // MARKED failed so the worker knows and can retry.
  blocTest<ChatBloc, ChatState>(
    'a send failure MARKS the worker message failed (never a silent drop)',
    build: () {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenThrow(const NetworkFailure());
      return ChatBloc(repo);
    },
    seed: () =>
        const ChatState(messages: <ChatMessage>[_opening], initializing: false),
    act: (ChatBloc b) => b.add(const ChatMessageSent('cnc')),
    // #870-tolerant: assert the transcript by SHAPE (see [_stateLike]).
    expect: () => <Matcher>[
      // Typing on while the send is in flight.
      _stateLike(<(String, bool, ChatSendStatus)>[
        (_opening.text, false, ChatSendStatus.sent),
        ('cnc', true, ChatSendStatus.sent),
      ], sending: true),
      // Failure: the message is kept BUT flagged undelivered + retryable.
      _stateLike(<(String, bool, ChatSendStatus)>[
        (_opening.text, false, ChatSendStatus.sent),
        ('cnc', true, ChatSendStatus.failed),
      ]),
    ],
  );

  group('send failure + retry (#343)', () {
    test('tapping retry re-sends in place and heals the bubble', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      // Fail once, then succeed.
      int calls = 0;
      when(() => repo.sendMessage('cnc', submissionId: any(named: 'submissionId'))).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const NetworkFailure();
        return const ChatTurn(reply: 'Got it.');
      });

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('cnc'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bloc.state.messages[1].status, ChatSendStatus.failed);

      // The worker taps the failed bubble (index 1).
      bloc.add(const ChatRetryRequested(1));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(bloc.state.messages[1].status, ChatSendStatus.sent,
          reason: 'the bubble healed');
      expect(
        bloc.state.messages.map((ChatMessage m) => m.text).toList(),
        <String>[_opening.text, 'cnc', 'Got it.'],
        reason: 'retry must NOT append a duplicate bubble',
      );
      expect(calls, 2);
    });

    test('a still-failing retry re-marks the bubble failed', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenThrow(const NetworkFailure());

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('cnc'));
      await Future<void>.delayed(const Duration(milliseconds: 50));
      bloc.add(const ChatRetryRequested(1));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(bloc.state.messages[1].status, ChatSendStatus.failed);
      expect(bloc.state.sending, isFalse);
    });

    test('a successful send clears the failed-session banner', () async {
      // Session open fails, but the next send heals it (repo-level self-heal).
      when(() => repo.ensureSession()).thenThrow(const NetworkFailure());
      when(() => repo.sendMessage('cnc', submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'Got it.'));

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatStarted());
      await Future<void>.delayed(const Duration(milliseconds: 50));
      expect(bloc.state.sessionFailed, isTrue);

      bloc.add(const ChatMessageSent('cnc'));
      await Future<void>.delayed(const Duration(milliseconds: 50));

      expect(bloc.state.sessionFailed, isFalse,
          reason: 'a delivered message proves the session is open again');
    });

    test('retry ignores a non-failed or out-of-range index', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      // index 0 is bada bhai's opening message — not retryable.
      bloc.add(const ChatRetryRequested(0));
      bloc.add(const ChatRetryRequested(99));
      await Future<void>.delayed(const Duration(milliseconds: 30));

      verifyNever(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')));
    });
  });

  // #344 — bloc 8.x runs handlers CONCURRENTLY by default. The reply emit used
  // to spread a `withWorker` list captured BEFORE the await, so a slow reply
  // re-emitted a stale transcript and erased anything appended meanwhile.
  group('concurrent sends (#344)', () {
    test('a slow reply does not erase bubbles from a later send', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      // A is slow, B is fast → B's bubble+reply land while A is still in flight,
      // so A's reply emit is the one that used to clobber them.
      when(() => repo.sendMessage('A', submissionId: any(named: 'submissionId'))).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 100));
        return const ChatTurn(reply: 'replyA');
      });
      when(() => repo.sendMessage('B', submissionId: any(named: 'submissionId'))).thenAnswer((_) async {
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
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage('A', submissionId: any(named: 'submissionId'))).thenAnswer((_) async {
        await Future<void>.delayed(const Duration(milliseconds: 150));
        return const ChatTurn(reply: 'replyA');
      });
      when(() => repo.sendMessage('B', submissionId: any(named: 'submissionId'))).thenAnswer((_) async {
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
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage('typed', submissionId: any(named: 'submissionId'))).thenAnswer((_) async {
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

  // #478 — the named-gaps signal. A non-blocked turn threads the current gaps
  // into state; a blocked turn (server degrades essentials to [] = "unknown")
  // must KEEP the last known gaps, never clear them to a false "complete".
  test('unanswered_essentials thread through, and a blocked turn keeps them',
      () async {
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    final ChatBloc bloc = ChatBloc(repo);
    addTearDown(bloc.close);

    when(() => repo.sendMessage('a', submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
        reply: 'r1', unansweredEssentials: <String>['machines', 'experience']));
    bloc.add(const ChatMessageSent('a'));
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(bloc.state.unansweredEssentials, <String>['machines', 'experience']);
    expect(bloc.state.lastReplyBlocked, isFalse);

    when(() => repo.sendMessage('b', submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
        reply: 'r2', blocked: true, unansweredEssentials: <String>[]));
    bloc.add(const ChatMessageSent('b'));
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(bloc.state.unansweredEssentials, <String>['machines', 'experience'],
        reason: 'a blocked turn must not clear the last known gaps');
    expect(bloc.state.lastReplyBlocked, isTrue);
  });

  // OIE Phase 8 (#649) — progress, question_kind and occupation thread into the
  // state; progress + occupation are sticky, question_kind is turn-scoped.
  group('OIE Phase 8 fields (#649)', () {
    test('a turn carries progress, question_kind and occupation to state',
        () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
            reply: 'Aap darzi hain?',
            followups: <String>['darzi', 'Kuch aur'],
            progress: ChatProgress(answered: 3, total: 12),
            questionKind: ChatQuestionKind.disambiguate,
            occupationLabel: 'darzi',
          ));
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('main kapde silta hoon'));
      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(bloc.state.progress?.answered, 3);
      expect(bloc.state.progress?.total, 12);
      expect(bloc.state.questionKind, ChatQuestionKind.disambiguate);
      expect(bloc.state.occupationLabel, 'darzi');
    });

    test('progress + occupation are STICKY; question_kind is turn-scoped',
        () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      final List<ChatTurn> turns = <ChatTurn>[
        const ChatTurn(
          reply: 'q1',
          progress: ChatProgress(answered: 3, total: 12),
          questionKind: ChatQuestionKind.disambiguate,
          occupationLabel: 'darzi',
        ),
        // A later ordinary turn: no progress, no occupation, plain 'ask'.
        const ChatTurn(reply: 'q2'),
      ];
      int i = 0;
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer((_) async => turns[i++]);
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('a'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      bloc.add(const ChatMessageSent('b'));
      await Future<void>.delayed(const Duration(milliseconds: 30));

      expect(bloc.state.progress?.answered, 3,
          reason: 'progress sticky-forward across a null-progress turn');
      expect(bloc.state.occupationLabel, 'darzi',
          reason: 'occupation latches once pinned');
      expect(bloc.state.questionKind, ChatQuestionKind.ask,
          reason: 'the 2nd turn is a plain ask — the disambiguate layout drops');
    });

    test('input_mode is TURN-SCOPED: an options_only turn then a text turn '
        'brings the composer back (#770)', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      final List<ChatTurn> turns = <ChatTurn>[
        const ChatTurn(
          reply: 'Aur koi experience jodna hai?',
          followups: <String>['Haan', 'Nahi'],
          inputMode: ChatInputMode.optionsOnly,
        ),
        // A normal reply — inputMode omitted defaults to text.
        const ChatTurn(reply: 'Theek hai'),
      ];
      int i = 0;
      when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId'))).thenAnswer((_) async => turns[i++]);
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('CNC'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.inputMode, ChatInputMode.optionsOnly,
          reason: 'the options_only turn locks the composer');

      bloc.add(const ChatMessageSent('Haan'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.inputMode, ChatInputMode.text,
          reason: 'a normal turn returns the composer — never latched');
    });
  });

  // #761 — the advisory lookahead: render the predicted next turn on the tap,
  // reconcile when the real reply lands. NEVER an answer of record.
  group('optimistic lookahead (#761)', () {
    const PredictedQuestion predSkills = PredictedQuestion(
      questionKey: 'skills',
      promptText: 'Aapko kaunse kaam aate hain?',
      options: <String>['Welding', 'Fitting'],
      progress: ChatProgress(answered: 4, total: 12),
    );

    /// Drives one turn that leaves the bloc with chips + a lookahead keyed
    /// 'Fanuc', then returns the bloc with the 'Fanuc' send held open on
    /// [pending] so the optimistic render can be observed pre-reply.
    Future<ChatBloc> primeAndTapFanuc(Completer<ChatTurn> pending) async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage('cnc', submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
            reply: 'Kaunsa control?',
            followups: <String>['Fanuc', 'Siemens'],
            askedQuestionId: 'controller',
            lookahead: <String, PredictedQuestion?>{'Fanuc': predSkills},
          ));
      when(() => repo.sendMessage('Fanuc', submissionId: any(named: 'submissionId'))).thenAnswer((_) => pending.future);

      final ChatBloc bloc = ChatBloc(repo);
      bloc.add(const ChatMessageSent('cnc'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      // Precondition: the prediction is available for the next tap.
      expect(bloc.state.lookahead.containsKey('Fanuc'), isTrue);

      bloc.add(const ChatMessageSent('Fanuc', optionKey: 'Fanuc'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      return bloc;
    }

    test('(a) renders the predicted bubble + chips + progress BEFORE the reply',
        () async {
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      final ChatBloc bloc = await primeAndTapFanuc(pending);
      addTearDown(bloc.close);

      expect(pending.isCompleted, isFalse,
          reason: 'the repo has not replied — this render is optimistic');
      final List<String> texts =
          bloc.state.messages.map((ChatMessage m) => m.text).toList();
      expect(texts.last, predSkills.promptText,
          reason: 'the predicted question is on screen already');
      expect(texts, contains('Fanuc'), reason: 'the tapped label is the answer');
      // EXACTLY ONCE. `contains` above is satisfied by a duplicate, and the bot-bubble
      // counts in (b)/(c) filter on `!fromWorker`, so nothing here would otherwise notice
      // the worker's own answer being appended twice. The optimistic and plain branches
      // each append it exactly once and are mutually exclusive — a refactor that restores
      // a shared append ahead of them (or merges this handler with one that has one) puts
      // two identical bubbles on screen, and only the first is ever marked sent because
      // `index` predates both.
      expect(
        texts.where((String t) => t == 'Fanuc'),
        hasLength(1),
        reason: 'the worker bubble is appended by exactly one branch',
      );
      expect(bloc.state.followups, predSkills.options);
      expect(bloc.state.progress?.answered, 4);
      expect(bloc.state.progress?.total, 12);
      expect(bloc.state.predictedQuestionKey, 'skills');
      expect(bloc.state.sending, isTrue);
    });

    test('(b) agreement keeps ONE bot bubble and refreshes metadata',
        () async {
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      final ChatBloc bloc = await primeAndTapFanuc(pending);
      addTearDown(bloc.close);

      // The real reply's asked_question_id MATCHES the prediction's key.
      pending.complete(const ChatTurn(
        reply: 'Aap konsa kaam karte hain — bataiye.',
        askedQuestionId: 'skills',
        followups: <String>['Welding', 'Fitting', 'Turning'],
        progress: ChatProgress(answered: 4, total: 12),
      ));
      await Future<void>.delayed(const Duration(milliseconds: 20));

      final List<ChatMessage> bots =
          bloc.state.messages.where((ChatMessage m) => !m.fromWorker).toList();
      // opening + turn-1 reply + the single kept predicted bubble = 3 bot bubbles.
      expect(bots, hasLength(3));
      expect(bots.last.text, predSkills.promptText,
          reason: 'agreement keeps the optimistic bubble (no flicker)');
      expect(bloc.state.followups, <String>['Welding', 'Fitting', 'Turning'],
          reason: 'metadata still refreshes from the real turn');
      expect(bloc.state.predictedQuestionKey, isNull,
          reason: 'the prediction is reconciled and cleared');
    });

    test('(c) disagreement REPLACES the optimistic bubble (still one bubble)',
        () async {
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      final ChatBloc bloc = await primeAndTapFanuc(pending);
      addTearDown(bloc.close);

      // The real reply is a DIFFERENT question than predicted.
      pending.complete(const ChatTurn(
        reply: 'Kaunsi machine chalate hain?',
        askedQuestionId: 'machines',
        followups: <String>['CNC', 'VMC'],
      ));
      await Future<void>.delayed(const Duration(milliseconds: 20));

      final List<ChatMessage> bots =
          bloc.state.messages.where((ChatMessage m) => !m.fromWorker).toList();
      expect(bots, hasLength(3),
          reason: 'the optimistic bubble is replaced, never doubled');
      expect(bots.last.text, 'Kaunsi machine chalate hain?');
      expect(bloc.state.messages.map((ChatMessage m) => m.text),
          isNot(contains(predSkills.promptText)),
          reason: 'the wrong prediction was overwritten');
      expect(bloc.state.followups, <String>['CNC', 'VMC']);
      expect(bloc.state.predictedQuestionKey, isNull);
    });

    test('(d) absent lookahead → today\'s flow (append, no optimistic bubble)',
        () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      when(() => repo.sendMessage('cnc', submissionId: any(named: 'submissionId'))).thenAnswer((_) => pending.future);
      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      // A typed send: no optionKey, no prediction on screen.
      bloc.add(const ChatMessageSent('cnc'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(bloc.state.predictedQuestionKey, isNull);
      // Only the worker bubble is appended; no phantom bot bubble.
      expect(bloc.state.messages.last.text, 'cnc');
      expect(bloc.state.messages.last.fromWorker, isTrue);

      pending.complete(const ChatTurn(reply: 'Theek hai.'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      expect(bloc.state.messages.last.text, 'Theek hai.');
    });

    test('(e) the submit body is byte-identical and the prediction is NEVER sent',
        () async {
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      final ChatBloc bloc = await primeAndTapFanuc(pending);
      addTearDown(bloc.close);
      pending.complete(const ChatTurn(reply: 'ok', askedQuestionId: 'skills'));
      await Future<void>.delayed(const Duration(milliseconds: 20));

      // The wire send is the tapped LABEL, verbatim and once — the predicted
      // prompt is a render-only artefact and reaches no endpoint.
      verify(() => repo.sendMessage('Fanuc', submissionId: any(named: 'submissionId'))).called(1);
      verifyNever(() => repo.sendMessage(predSkills.promptText, submissionId: any(named: 'submissionId')));
    });

    test('a failed send RETRACTS the optimistic bubble and marks the answer failed',
        () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage('cnc', submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
            reply: 'Kaunsa control?',
            followups: <String>['Fanuc', 'Siemens'],
            askedQuestionId: 'controller',
            lookahead: <String, PredictedQuestion?>{'Fanuc': predSkills},
          ));
      when(() => repo.sendMessage('Fanuc', submissionId: any(named: 'submissionId'))).thenThrow(const NetworkFailure());

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);
      bloc.add(const ChatMessageSent('cnc'));
      await Future<void>.delayed(const Duration(milliseconds: 20));

      bloc.add(const ChatMessageSent('Fanuc', optionKey: 'Fanuc'));
      await Future<void>.delayed(const Duration(milliseconds: 20));

      final List<String> texts =
          bloc.state.messages.map((ChatMessage m) => m.text).toList();
      expect(texts, isNot(contains(predSkills.promptText)),
          reason: 'the predicted turn never happened — drop it on failure');
      // The worker's 'Fanuc' answer is kept, marked failed + retryable (#343).
      final ChatMessage last = bloc.state.messages.last;
      expect(last.text, 'Fanuc');
      expect(last.status, ChatSendStatus.failed);
      expect(bloc.state.predictedQuestionKey, isNull);
    });

    // #761 THE FIX — on the LLM chat the chip LABEL differs from the stable
    // `option_key` that `lookahead` is keyed by. Indexing the prediction by the
    // label missed and the optimistic render silently never fired. The bloc
    // indexes by the option_key it is handed WHILE submitting the label verbatim.
    test('a chip whose option_key differs from its label renders the prediction '
        'and STILL submits the label', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      // Turn 1 leaves a lookahead keyed by the STABLE option_key, not the label.
      when(() => repo.sendMessage('kaam', submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
            reply: 'Kaunsa kaam?',
            followups: <String>['Salad bar attendant', 'Kuch aur'],
            suggestedOptions: <ChatOption>[
              ChatOption(
                optionKey: 'role_salad_bar',
                labelText: 'Salad bar attendant',
              ),
            ],
            askedQuestionId: 'role',
            lookahead: <String, PredictedQuestion?>{'role_salad_bar': predSkills},
          ));
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      when(() => repo.sendMessage('Salad bar attendant', submissionId: any(named: 'submissionId')))
          .thenAnswer((_) => pending.future);

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);
      bloc.add(const ChatMessageSent('kaam'));
      await Future<void>.delayed(const Duration(milliseconds: 20));
      // The prediction is keyed by the option_key, NOT the label.
      expect(bloc.state.lookahead.containsKey('role_salad_bar'), isTrue);
      expect(bloc.state.lookahead.containsKey('Salad bar attendant'), isFalse);

      // The screen submits the LABEL as the answer but indexes by the option_key.
      bloc.add(const ChatMessageSent('Salad bar attendant',
          optionKey: 'role_salad_bar'));
      await Future<void>.delayed(const Duration(milliseconds: 20));

      // The optimistic prediction FIRED (this is exactly what missed before).
      expect(pending.isCompleted, isFalse, reason: 'render is pre-reply');
      expect(bloc.state.messages.last.text, predSkills.promptText,
          reason: 'the predicted next question is on screen before the reply');
      expect(bloc.state.predictedQuestionKey, 'skills');
      // And the wire submit is the LABEL, byte-identical — never the option_key.
      verify(() => repo.sendMessage('Salad bar attendant', submissionId: any(named: 'submissionId'))).called(1);
      verifyNever(() => repo.sendMessage('role_salad_bar', submissionId: any(named: 'submissionId')));
    });

    // The none-of-above option must map to the '__declined' lookahead key even
    // though its label_text is an ordinary phrase.
    test('an is_none_of_above option indexes the __declined prediction', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage('kaam', submissionId: any(named: 'submissionId'))).thenAnswer((_) async => const ChatTurn(
            reply: 'Kaunsa kaam?',
            followups: <String>['Kuch aur'],
            suggestedOptions: <ChatOption>[
              ChatOption(
                optionKey: '__none',
                labelText: 'Kuch aur',
                isNoneOfAbove: true,
              ),
            ],
            lookahead: <String, PredictedQuestion?>{'__declined': predSkills},
          ));
      final Completer<ChatTurn> pending = Completer<ChatTurn>();
      when(() => repo.sendMessage('Kuch aur', submissionId: any(named: 'submissionId'))).thenAnswer((_) => pending.future);

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);
      bloc.add(const ChatMessageSent('kaam'));
      await Future<void>.delayed(const Duration(milliseconds: 20));

      // The escape option submits its label but indexes '__declined'.
      bloc.add(const ChatMessageSent('Kuch aur', optionKey: '__declined'));
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(bloc.state.messages.last.text, predSkills.promptText,
          reason: 'the __declined prediction rendered optimistically');
      verify(() => repo.sendMessage('Kuch aur', submissionId: any(named: 'submissionId'))).called(1);
    });
  });

  // #870 — the per-submission id. Minted per PHYSICAL send (rides the worker
  // bubble), re-sent verbatim on a retry, fresh on a new action — so the server
  // can tell a retried POST from a worker repeating the same words.
  group('per-submission id (#870)', () {
    test('a normal send mints a non-null submissionId on the worker bubble AND '
        'the repo receives that same id', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage('cnc',
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'ok'));

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('cnc'));
      await Future<void>.delayed(const Duration(milliseconds: 30));

      // The worker bubble (index 1; index 0 is the opener) carries the id.
      final ChatMessage worker = bloc.state.messages[1];
      expect(worker.fromWorker, isTrue);
      expect(worker.submissionId, isNotNull);

      // And the SAME id reached the repo on the wire.
      final List<dynamic> sent = verify(() => repo.sendMessage(
          'cnc', submissionId: captureAny(named: 'submissionId'))).captured;
      expect(sent, hasLength(1));
      expect(sent.single, worker.submissionId,
          reason: 'the bubble id is exactly what was submitted');
    });

    test('a NEW message gets a DIFFERENT id', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(reply: 'ok'));

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('first'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      bloc.add(const ChatMessageSent('second'));
      await Future<void>.delayed(const Duration(milliseconds: 30));

      final List<dynamic> ids = verify(() => repo.sendMessage(
          any(), submissionId: captureAny(named: 'submissionId'))).captured;
      expect(ids, hasLength(2));
      expect(ids[0], isNotNull);
      expect(ids[1], isNotNull);
      expect(ids[0], isNot(ids[1]),
          reason: 'a fresh action is a new submission, not a retry');
    });

    test('a RETRY re-sends the SAME id the original send used', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      // Fail once (so the bubble becomes retryable), then succeed on the retry.
      int calls = 0;
      when(() => repo.sendMessage('cnc',
          submissionId: any(named: 'submissionId'))).thenAnswer((_) async {
        calls++;
        if (calls == 1) throw const NetworkFailure();
        return const ChatTurn(reply: 'ok');
      });

      final ChatBloc bloc = ChatBloc(repo);
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('cnc'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.messages[1].status, ChatSendStatus.failed);

      bloc.add(const ChatRetryRequested(1));
      await Future<void>.delayed(const Duration(milliseconds: 30));
      expect(bloc.state.messages[1].status, ChatSendStatus.sent);

      final List<dynamic> ids = verify(() => repo.sendMessage(
          'cnc', submissionId: captureAny(named: 'submissionId'))).captured;
      expect(ids, hasLength(2), reason: 'the original send + the retry');
      expect(ids[0], isNotNull);
      expect(ids[1], ids[0],
          reason: 'a retry re-sends the ORIGINAL id, never a fresh one');
    });
  });
}

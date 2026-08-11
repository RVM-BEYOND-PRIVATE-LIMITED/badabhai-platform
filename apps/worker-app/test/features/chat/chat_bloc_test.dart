import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart'
    show ChatInputMode, ChatProgress, ChatQuestionKind;
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

// The opener is now owned by the bloc (#422) — reference the exported
// constant so a copy change can never silently desync the tests from the app.
const ChatMessage _opening = kChatOpeningMessage;

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

  // #343 — this test used to assert the SILENT DROP as intended behaviour
  // ("frozen UI"), actively protecting the defect: an undelivered message stayed
  // rendered as if it had been sent. It now asserts the opposite — the bubble is
  // MARKED failed so the worker knows and can retry.
  blocTest<ChatBloc, ChatState>(
    'a send failure MARKS the worker message failed (never a silent drop)',
    build: () {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
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
      // Failure: the message is kept BUT flagged undelivered + retryable.
      ChatState(
        messages: <ChatMessage>[
          _opening,
          ChatMessage(
            text: 'cnc',
            fromWorker: true,
            status: ChatSendStatus.failed,
          ),
        ],
        initializing: false,
      ),
    ],
  );

  group('send failure + retry (#343)', () {
    test('tapping retry re-sends in place and heals the bubble', () async {
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      // Fail once, then succeed.
      int calls = 0;
      when(() => repo.sendMessage('cnc')).thenAnswer((_) async {
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
      when(() => repo.sendMessage(any())).thenThrow(const NetworkFailure());

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
      when(() => repo.sendMessage('cnc'))
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

      verifyNever(() => repo.sendMessage(any()));
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
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
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
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
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

  // #478 — the named-gaps signal. A non-blocked turn threads the current gaps
  // into state; a blocked turn (server degrades essentials to [] = "unknown")
  // must KEEP the last known gaps, never clear them to a false "complete".
  test('unanswered_essentials thread through, and a blocked turn keeps them',
      () async {
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    final ChatBloc bloc = ChatBloc(repo);
    addTearDown(bloc.close);

    when(() => repo.sendMessage('a')).thenAnswer((_) async => const ChatTurn(
        reply: 'r1', unansweredEssentials: <String>['machines', 'experience']));
    bloc.add(const ChatMessageSent('a'));
    await Future<void>.delayed(const Duration(milliseconds: 30));
    expect(bloc.state.unansweredEssentials, <String>['machines', 'experience']);
    expect(bloc.state.lastReplyBlocked, isFalse);

    when(() => repo.sendMessage('b')).thenAnswer((_) async => const ChatTurn(
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
      when(() => repo.sendMessage(any())).thenAnswer((_) async => const ChatTurn(
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
      when(() => repo.sendMessage(any())).thenAnswer((_) async => turns[i++]);
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
      when(() => repo.sendMessage(any())).thenAnswer((_) async => turns[i++]);
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
}

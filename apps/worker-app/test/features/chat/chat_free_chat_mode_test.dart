import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/observability/analytics.dart';
import 'package:badabhai_worker_app/core/session/chat_turn_resume_store.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_free_chat_keys.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/core/api/api_models.dart' show ChatOption;
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// ── ADR-0051 FREE CHAT, APP SIDE (#2030 asks 3 and 5) ───────────────────────
///
/// The mode is STICKY and read off the chip the worker tapped, because the wire
/// carries no mode field (ADR-0051 §3.8 adds only `read_aloud`) and the résumé
/// chip is absent on the greeting and on a distress turn.
void main() {
  late MockChatRepository repo;
  late List<BbAnalyticsEvent> events;
  late InMemoryChatTurnResumeStore store;

  setUp(() {
    repo = MockChatRepository();
    events = <BbAnalyticsEvent>[];
    store = InMemoryChatTurnResumeStore();
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.loadHistory()).thenAnswer((_) async => const []);
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(reply: 'ok'));
  });

  ChatBloc buildBloc() =>
      ChatBloc(repo, analyticsSink: events.add, turnResume: store);

  List<int> spokenIndices() => events
      .where((BbAnalyticsEvent e) => e.name == 'profiling_answer_spoken')
      .map((BbAnalyticsEvent e) => e.parameters['question_index']! as int)
      .toList();

  Future<void> settle() =>
      Future<void>.delayed(const Duration(milliseconds: 40));

  group('the mode follows the tapped chip', () {
    test('"Baad mein" opens free chat; "Resume banayein" closes it', () async {
      final ChatBloc bloc = buildBloc();
      addTearDown(bloc.close);

      expect(bloc.state.freeChat, isFalse, reason: 'the interview is default');

      bloc.add(const ChatMessageSent('Baad mein',
          optionKey: kFreeChatLaterKey, servedOption: true));
      await settle();
      expect(bloc.state.freeChat, isTrue);

      bloc.add(const ChatMessageSent(kFreeChatResumeLabel,
          optionKey: kFreeChatResumeKey, servedOption: true));
      await settle();
      expect(bloc.state.freeChat, isFalse);
    });

    test('a model follow-up chip and a typed line do NOT end free chat',
        () async {
      final ChatBloc bloc = buildBloc();
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('Baad mein',
          optionKey: kFreeChatLaterKey, servedOption: true));
      await settle();

      // `fcq_*` is a model-written follow-up: it keeps the worker IN free chat.
      bloc.add(const ChatMessageSent('Haan bilkul',
          optionKey: 'fcq_a', servedOption: true));
      await settle();
      expect(bloc.state.freeChat, isTrue);

      // And a typed message says nothing about the mode either.
      bloc.add(const ChatMessageSent('mausam kaisa hai'));
      await settle();
      expect(bloc.state.freeChat, isTrue,
          reason: 'null from freeChatModeAfterTap must mean "keep the mode", '
              'not "back to the interview"');
    });

    test('"Haan, shuru karein" starts the interview', () async {
      final ChatBloc bloc = buildBloc();
      addTearDown(bloc.close);
      bloc.add(const ChatMessageSent('Baad mein',
          optionKey: kFreeChatLaterKey, servedOption: true));
      await settle();
      bloc.add(const ChatMessageSent('Haan, shuru karein',
          optionKey: kFreeChatStartKey, servedOption: true));
      await settle();
      expect(bloc.state.freeChat, isFalse);
    });
  });

  group('#2030 ask 5 — free chat is not the interview', () {
    test('free-chat sends carry no #1316 per-ask index', () async {
      final ChatBloc bloc = buildBloc();
      addTearDown(bloc.close);

      // One real interview answer first, so index 1 is taken.
      bloc.add(const ChatMessageSent('welder hoon'));
      await settle();
      expect(spokenIndices(), <int>[1]);

      // Choosing a mode is not answering an ask — not even this tap itself.
      bloc.add(const ChatMessageSent('Baad mein',
          optionKey: kFreeChatLaterKey, servedOption: true));
      await settle();
      bloc.add(const ChatMessageSent('cricket dekha?'));
      await settle();
      bloc.add(const ChatMessageSent('Haan bilkul',
          optionKey: 'fcq_a', servedOption: true));
      await settle();

      expect(spokenIndices(), <int>[1],
          reason: 'three free-chat sends must add nothing to the curve');
    });

    test('and the interview resumes counting once free chat ends', () async {
      final ChatBloc bloc = buildBloc();
      addTearDown(bloc.close);

      bloc.add(const ChatMessageSent('Baad mein',
          optionKey: kFreeChatLaterKey, servedOption: true));
      await settle();
      bloc.add(const ChatMessageSent('bas timepass'));
      await settle();
      expect(spokenIndices(), isEmpty);

      bloc.add(const ChatMessageSent(kFreeChatResumeLabel,
          optionKey: kFreeChatResumeKey, servedOption: true));
      await settle();
      bloc.add(const ChatMessageSent('das saal'));
      await settle();

      expect(spokenIndices(), isNotEmpty,
          reason: 'the interview is being answered again');
    });
  });

  group('#2030 ask 3 — chips survive a cold start', () {
    test('a served turn is remembered with its mode', () async {
      when(() => repo.sendMessage(any(),
              submissionId: any(named: 'submissionId')))
          .thenAnswer((_) async => const ChatTurn(
                reply: 'Bataiye',
                suggestedOptions: <ChatOption>[
                  ChatOption(
                      optionKey: kFreeChatResumeKey,
                      labelText: kFreeChatResumeLabel),
                ],
              ));

      final ChatBloc bloc = buildBloc();
      addTearDown(bloc.close);
      bloc.add(const ChatMessageSent('Baad mein',
          optionKey: kFreeChatLaterKey, servedOption: true));
      await settle();

      final ChatTurnResumeState? saved = await store.read();
      expect(saved, isNotNull);
      expect(saved!.sessionId, 's1');
      expect(saved.freeChat, isTrue);
      expect(saved.options.single.optionKey, kFreeChatResumeKey);
    });

    test('a cold start redraws the remembered chips and mode', () async {
      await store.write(const ChatTurnResumeState(
        sessionId: 's1',
        options: <({String optionKey, String labelText})>[
          (optionKey: kFreeChatStartKey, labelText: 'Haan, shuru karein'),
          (optionKey: kFreeChatLaterKey, labelText: 'Baad mein'),
        ],
        freeChat: false,
      ));

      final ChatBloc bloc = buildBloc();
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();

      // The greeting's chips are back — the transcript redraw cannot carry them
      // and a resumed session serves no opening.
      expect(
        bloc.state.suggestedOptions.map((ChatOption o) => o.optionKey),
        <String>[kFreeChatStartKey, kFreeChatLaterKey],
      );
      expect(bloc.state.followups, <String>['Haan, shuru karein', 'Baad mein']);
    });

    test('#2190 — a cold start mid-trade-gate redraws the gate chips', () async {
      // The gate's stable keys survive the store round-trip exactly like any
      // other served turn; the transcript redraw (bubbles only) plus these
      // chips is the mid-gate redraw the issue asks to confirm.
      await store.write(const ChatTurnResumeState(
        sessionId: 's1',
        options: <({String optionKey, String labelText})>[
          (optionKey: 'trade_confirm_yes', labelText: 'Haan'),
          (optionKey: 'trade_confirm_no', labelText: 'Nahi'),
        ],
        freeChat: false,
      ));

      final ChatBloc bloc = buildBloc();
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();

      expect(
        bloc.state.suggestedOptions.map((ChatOption o) => o.optionKey),
        <String>['trade_confirm_yes', 'trade_confirm_no'],
      );
      expect(bloc.state.followups, <String>['Haan', 'Nahi']);
    });

    test('chips from ANOTHER session are never drawn', () async {
      await store.write(const ChatTurnResumeState(
        sessionId: 'a-session-the-worker-left',
        options: <({String optionKey, String labelText})>[
          (optionKey: kFreeChatResumeKey, labelText: kFreeChatResumeLabel),
        ],
        freeChat: true,
      ));

      final ChatBloc bloc = buildBloc();
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();

      expect(bloc.state.suggestedOptions, isEmpty);
      expect(bloc.state.freeChat, isFalse);
    });

    test('a SERVED opening always wins over a remembered turn', () async {
      await store.write(const ChatTurnResumeState(
        sessionId: 's1',
        options: <({String optionKey, String labelText})>[
          (optionKey: kFreeChatLaterKey, labelText: 'Baad mein'),
        ],
        freeChat: true,
      ));
      when(() => repo.ensureSession()).thenAnswer((_) async => ChatSessionOpening(
            text: 'Namaste, main Bada Bhai hoon. Shuru karein?',
            options: const <ChatOption>[
              ChatOption(optionKey: 'section_skills', labelText: 'Skills'),
            ],
          ));

      final ChatBloc bloc = buildBloc();
      addTearDown(bloc.close);
      bloc.add(const ChatStarted());
      await settle();

      expect(
        bloc.state.suggestedOptions.single.optionKey,
        'section_skills',
        reason: 'the live turn is the truth; the remembered one is a fallback',
      );
    });
  });
}

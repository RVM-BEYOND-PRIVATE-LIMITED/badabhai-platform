// OWNER ASK (2026-10-12) — a location question the worker abandoned (closed the
// app, or backed out) is REMEMBERED and offered again on reopen as a "Location
// bharein" BUTTON. The dialog does NOT auto-open on a resume; it opens only when
// the worker taps the button, and the composer/mic stay locked.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/chat_turn_resume_store.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_identity_questions.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_prompt.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/chat/presentation/widgets/chat_location_card.dart';

import '../../core/auth/fakes.dart';

class MockChatRepository extends Mock implements ChatRepository {}

void main() {
  late MockChatRepository repo;

  const ChatTurnResumeState saved = ChatTurnResumeState(
    sessionId: 's1',
    options: <({String optionKey, String labelText})>[],
    freeChat: false,
    askedQuestionKey: kChatStateQuestionKey,
  );

  setUp(() {
    repo = MockChatRepository();
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.loadHistory()).thenAnswer((_) async => const []);
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
  });

  tearDown(() async => locator.reset());

  // ── bloc: the restore carries the question and the "restored" flag ─────────
  test(
    'a pending location question is restored with questionRestored',
    () async {
      final ChatBloc bloc = ChatBloc(
        repo,
        turnResume: InMemoryChatTurnResumeStore(saved),
      );
      addTearDown(bloc.close);

      bloc.add(const ChatStarted());
      await Future<void>.delayed(const Duration(milliseconds: 40));

      expect(bloc.state.askedQuestionKey, kChatStateQuestionKey);
      expect(
        bloc.state.questionRestored,
        isTrue,
        reason: 'the question came back from a cold start, not a served turn',
      );
    },
  );

  // THE BUG THIS FIXES: the location question can be the FRESH session's
  // opening bubble (`confirm_first: true`), and the open path never remembered a
  // question — so closing the app mid-location left nothing to restore.
  test('the session OPENING question is persisted', () async {
    when(() => repo.ensureSession()).thenAnswer(
      (_) async => const ChatSessionOpening(
        text: 'Aap kis state mein rehte hain?',
        questionKey: kChatStateQuestionKey,
      ),
    );
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
    final InMemoryChatTurnResumeStore store = InMemoryChatTurnResumeStore();
    final ChatBloc bloc = ChatBloc(repo, turnResume: store);
    addTearDown(bloc.close);

    bloc.add(const ChatStarted());
    await Future<void>.delayed(const Duration(milliseconds: 40));

    expect(
      (await store.read())?.askedQuestionKey,
      kChatStateQuestionKey,
      reason: 'the opening question must be remembered for the cold restart',
    );
  });

  test(
    'nothing is restored when the remembered turn carried no question',
    () async {
      final ChatBloc bloc = ChatBloc(
        repo,
        turnResume: InMemoryChatTurnResumeStore(
          const ChatTurnResumeState(
            sessionId: 's1',
            options: <({String optionKey, String labelText})>[
              (optionKey: 'free_chat_later', labelText: 'Baad mein'),
            ],
            freeChat: false,
          ),
        ),
      );
      addTearDown(bloc.close);

      bloc.add(const ChatStarted());
      await Future<void>.delayed(const Duration(milliseconds: 40));

      expect(bloc.state.askedQuestionKey, isNull);
      expect(bloc.state.questionRestored, isFalse);
    },
  );

  // THE DEFECT BEHIND THIS FILE: the production `ChatBloc` factory forgot to
  // pass the registered [ChatTurnResumeStore], so `_rememberTurn`/`_restoreTurn`
  // were dead in the real app — the location question was never persisted and a
  // cold start reopened on a live composer instead of the "Location bharein"
  // button. This pins the wiring through the real locator, not a hand-built bloc.
  test('the production locator wires the resume store into ChatBloc', () async {
    await locator.reset();
    addTearDown(locator.reset);
    setupLocator(apiClient: MockApiClient(), secureStore: FakeSecureStore());
    // Swap the network repository for the mock the bloc will be handed.
    locator.unregister<ChatRepository>();
    locator.registerSingleton<ChatRepository>(repo);
    final InMemoryChatTurnResumeStore store = InMemoryChatTurnResumeStore();
    locator.registerSingleton<ChatTurnResumeStore>(store);

    when(() => repo.ensureSession()).thenAnswer(
      (_) async => const ChatSessionOpening(
        text: 'Aap kis state mein rehte hain?',
        questionKey: kChatStateQuestionKey,
      ),
    );
    when(() => repo.loadHistory()).thenAnswer((_) async => const []);
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');

    final ChatBloc bloc = locator<ChatBloc>();
    addTearDown(bloc.close);
    bloc.add(const ChatStarted());
    await Future<void>.delayed(const Duration(milliseconds: 40));

    expect(
      (await store.read())?.askedQuestionKey,
      kChatStateQuestionKey,
      reason: 'the production ChatBloc factory must receive the registered '
          'resume store, or no question is ever remembered across a restart',
    );
  });

  // THE SCREENSHOT BUG (location_gad): the state question follows the name
  // behind the résumé prompt, so it is a STASHED turn. Flushing it re-saved the
  // resume store WITHOUT the question key — the dialog opened, the worker
  // closed the app, and the cold start found nothing to re-offer. The stashed
  // flush must carry the key.
  test('dismissing the résumé prompt remembers the stashed location question', () async {
    when(() => repo.ensureSession()).thenAnswer(
      (_) async => const ChatSessionOpening(
        text: 'Aapka pehla naam kya hai?',
        questionKey: kChatFirstNameQuestionKey,
      ),
    );
    when(
      () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
    ).thenAnswer(
      (_) async => const ChatTurn(
        reply: 'Aap kis state mein rehte hain?',
        askedQuestionId: kChatStateQuestionKey,
      ),
    );
    final InMemoryChatTurnResumeStore store = InMemoryChatTurnResumeStore();
    final ChatBloc bloc = ChatBloc(repo, turnResume: store);
    addTearDown(bloc.close);

    bloc.add(const ChatStarted());
    await Future<void>.delayed(const Duration(milliseconds: 40));
    // The name reveals → the résumé prompt stands and the state question is
    // stashed (the prompt path saves no question).
    bloc.add(const ChatMessageSent('ramesh kumar'));
    await Future<void>.delayed(const Duration(milliseconds: 40));
    // Declining flushes the stashed state question.
    bloc.add(const ChatResumePromptDeclined(kResumePromptNoResumeLabel));
    await Future<void>.delayed(const Duration(milliseconds: 40));

    expect(bloc.state.askedQuestionKey, kChatStateQuestionKey);
    expect(
      (await store.read())?.askedQuestionKey,
      kChatStateQuestionKey,
      reason: 'the stashed location question must be remembered across a '
          'restart, or the cold start shows a live composer instead of the '
          '"Location bharein" button',
    );
  });

  // THE FULL CYCLE (mirrors the location_gad screenshot): the worker answers
  // the name behind the résumé prompt, the state question lands, the app is
  // closed, and a COLD START must come back offering the button. Both blocs
  // share one store, exactly as the app's cold restart does.
  test('full cycle: name → résumé prompt → state question survives a restart',
      () async {
    const Duration step = Duration(milliseconds: 40);
    when(() => repo.loadHistory())
        .thenAnswer((_) async => const <ChatMessage>[]);
    when(() => repo.ensureSession()).thenAnswer(
      (_) async => const ChatSessionOpening(
        text: 'Aapka pehla naam kya hai?',
        questionKey: kChatFirstNameQuestionKey,
      ),
    );
    when(
      () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
    ).thenAnswer(
      (_) async => const ChatTurn(
        reply: 'Aap kis state mein rehte hain?',
        askedQuestionId: kChatStateQuestionKey,
      ),
    );
    final InMemoryChatTurnResumeStore store = InMemoryChatTurnResumeStore();

    final ChatBloc first = ChatBloc(repo, turnResume: store);
    first.add(const ChatStarted());
    await Future<void>.delayed(step);
    first.add(const ChatMessageSent('rishi ojha'));
    await Future<void>.delayed(step);
    first.add(const ChatResumePromptDeclined(kResumePromptNoResumeLabel));
    await Future<void>.delayed(step);
    expect(first.state.askedQuestionKey, kChatStateQuestionKey);
    await first.close();

    // Cold restart: the session resumes (no opening), the transcript redraws.
    when(() => repo.ensureSession()).thenAnswer((_) async => null);
    when(() => repo.loadHistory()).thenAnswer(
      (_) async => const <ChatMessage>[
        ChatMessage(text: 'Aapka pehla naam kya hai?', fromWorker: false),
        ChatMessage(text: 'rishi ojha', fromWorker: true),
        ChatMessage(text: 'Aap kis state mein rehte hain?', fromWorker: false),
      ],
    );
    final ChatBloc reborn = ChatBloc(repo, turnResume: store);
    addTearDown(reborn.close);
    reborn.add(const ChatStarted());
    await Future<void>.delayed(step);

    expect(reborn.state.askedQuestionKey, kChatStateQuestionKey);
    expect(
      reborn.state.questionRestored,
      isTrue,
      reason: 'the cold start must recognise the restored location question so '
          'the screen locks the composer and offers the button',
    );
  });

  // ── screen: the button, not an auto-dialog; composer locked ────────────────
  testWidgets(
    'a RESTORED location question offers the button, no auto-dialog',
    (WidgetTester tester) async {
      await locator.reset();
      locator.registerFactory<ChatBloc>(
        () => ChatBloc(repo, turnResume: InMemoryChatTurnResumeStore(saved)),
      );

      tester.view.physicalSize = const Size(400, 700);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(const MaterialApp(home: ChatProfilingScreen()));
      await tester.pump();
      await tester.pumpAndSettle();

      expect(find.byKey(kChatLocationRestoreCtaKey), findsOneWidget);
      expect(find.text(kChatLocationRestoreLabel), findsOneWidget);
      // The composer/mic are withdrawn — the button is the only path.
      expect(find.byType(TextField), findsNothing);
      expect(find.byIcon(Icons.mic), findsNothing);
      // The dialog did NOT auto-open on reopen.
      expect(find.text(kChatLocationConfirm), findsNothing);

      // Tapping the button opens the dialog.
      await tester.tap(find.byKey(kChatLocationRestoreCtaKey));
      await tester.pumpAndSettle();
      expect(find.text(kChatLocationConfirm), findsOneWidget);
    },
  );
}

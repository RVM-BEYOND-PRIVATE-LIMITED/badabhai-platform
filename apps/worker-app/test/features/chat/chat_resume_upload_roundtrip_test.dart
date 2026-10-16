import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/resume_import_signal.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_identity_questions.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_prompt.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_document_picker.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_upload_intent.dart';
import 'package:badabhai_worker_app/features/resume_import/domain/resume_importer.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/resume_upload_entry.dart';
import 'package:badabhai_worker_app/features/resume_import/presentation/resume_upload_screen.dart';

class MockChatRepository extends Mock implements ChatRepository {}

class _FakePicker implements ResumeDocumentPicker {
  @override
  Future<ResumePickResult> pickResume() async => ResumePickResult.picked(
        PickedResumeDocument(
          kind: ResumeDocumentKind.pdf,
          bytes: Uint8List.fromList(<int>[1, 2, 3]),
        ),
      );
}

class _FakeImporter implements ResumeImporter {
  _FakeImporter(this.outcome);

  final ResumeImportOutcome outcome;

  @override
  Future<ResumeImportOutcome> importResume(PickedResumeDocument document) async =>
      outcome;
}

/// ── THE DEVICE ROUND TRIP, THROUGH THE REAL ROUTER ────────────────────────
///
/// `chat_resume_import_e2e_test.dart` raises the signal BEFORE the chat is
/// built, so the prompt lands on a bloc state CHANGE and the screen's
/// `BlocListener` runs. That is not what the phone does, which is why it was
/// green while `resume_upload.jpg` was red.
///
/// On the phone the chat is ALREADY on the prompt, the chip `push`es the upload
/// screen on top of it (the chat is never torn down), and the upload screen
/// leaves with `go('/chat')`. The router reuses the chat's element, so NO
/// ChatState edge fires on the way back — no message, no `sending` flip, no
/// `initializing` flip — and every listener-gated check stays silent. This test
/// drives exactly that, so a fix that only works on a state edge fails here.
void main() {
  late MockChatRepository repo;

  ResumeImportOutcome outcome = const ResumeImportRoutedToChat();

  setUp(() async {
    repo = MockChatRepository();
    outcome = const ResumeImportRoutedToChat();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    locator.registerLazySingleton<ResumeImportSignal>(ResumeImportSignal.new);
    locator.registerFactory<ResumeDocumentPicker>(_FakePicker.new);
    locator.registerFactory<ResumeImporter>(() => _FakeImporter(outcome));
    when(() => repo.ensureSession()).thenAnswer(
      (_) async => const ChatSessionOpening(
        text: 'Aapka pehla naam kya hai?',
        questionKey: kChatFirstNameQuestionKey,
      ),
    );
    when(() => repo.loadHistory()).thenAnswer((_) async => const <ChatMessage>[]);
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
    when(
      () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
    ).thenAnswer(
      (_) async => const ChatTurn(
        reply: 'Aap kis state mein rehte hain?',
        askedQuestionId: kChatStateQuestionKey,
      ),
    );
  });

  tearDown(() async => locator.reset());

  GoRouter buildRouter() => GoRouter(
        initialLocation: '/chat',
        routes: <RouteBase>[
          GoRoute(
            path: '/chat',
            builder: (BuildContext _, GoRouterState state) =>
                ChatProfilingScreen(
              fromResumeImport: state.extra == kChatFromResumeImport,
            ),
          ),
          GoRoute(
            path: '/resume-upload',
            builder: (BuildContext _, GoRouterState state) => ResumeUploadScreen(
              autoUpload: state.extra is ResumeUploadAutoIntent,
            ),
          ),
        ],
      );

  Future<void> pumpApp(WidgetTester tester) async {
    tester.view.physicalSize = const Size(420, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp.router(routerConfig: buildRouter()));
    await tester.pumpAndSettle();
  }

  Future<void> reachThePrompt(WidgetTester tester) async {
    await tester.enterText(find.byType(TextField), 'Rishi Ojha');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
    expect(
      find.text(kResumePromptNoResumeLabel),
      findsOneWidget,
      reason: 'precondition: the chat is standing on the résumé prompt',
    );
  }

  Future<void> walkTheUploadDoor(WidgetTester tester) async {
    await tester.tap(find.text(kResumePromptUploadLabel));
    await tester.pumpAndSettle();
    // The upload screen auto-clicked door 1, read the document and left.
    await tester.pumpAndSettle();
  }

  testWidgets('back from a completed upload, the prompt is answered — not re-asked',
      (WidgetTester tester) async {
    await pumpApp(tester);
    await reachThePrompt(tester);
    await walkTheUploadDoor(tester);

    expect(find.byType(ChatProfilingScreen), findsOneWidget);
    expect(
      find.text(kResumePromptNoResumeLabel),
      findsNothing,
      reason: 'resume_upload.jpg: the chips must not survive the upload',
    );
    expect(find.text(kResumePromptUploadLabel), findsWidgets,
        reason: 'the door he walked through is his own answer');
    expect(find.text('Aap kis state mein rehte hain?'), findsOneWidget,
        reason: 'the question stashed behind the prompt is released');
  });

  testWidgets('an import that learned NOTHING releases the prompt too',
      (WidgetTester tester) async {
    // `cameFromImport` is false here, so the route extra carries nothing —
    // the branch both earlier fixes silently missed.
    outcome = const ResumeImportRoutedToChat(learnedNothing: true);
    await pumpApp(tester);
    await reachThePrompt(tester);
    await walkTheUploadDoor(tester);

    expect(find.text(kResumePromptNoResumeLabel), findsNothing);
    expect(find.text('Aap kis state mein rehte hain?'), findsOneWidget);
  });

  testWidgets('a closed upload door releases the prompt too',
      (WidgetTester tester) async {
    outcome = const ResumeImportUnavailable();
    await pumpApp(tester);
    await reachThePrompt(tester);
    await walkTheUploadDoor(tester);

    expect(find.text(kResumePromptNoResumeLabel), findsNothing);
    expect(find.text('Aap kis state mein rehte hain?'), findsOneWidget);
  });

  // ── AN UPLOAD ENTRY OUTSIDE THE CHAT NEVER ANSWERS A LATER PROMPT ─────────
  //
  // The entries on the Résumé tab, "Mere resume" and the Profile tab open the
  // upload screen through `openResumeUploadEntry`. No prompt is standing open
  // behind them, so their import must leave NO signal: one left behind sits
  // until the chat next puts the résumé prompt on screen, and answers it with
  // "Resume upload karein" for the worker — releasing the stashed question
  // over a choice they never made.
  //
  // Driven the way the phone does it: the entry's real push, the screen's
  // auto-opened picker and finished import, its `go` to the Bada Bhai tab, and
  // the prompt arriving on that chat's own next turn — the path of a worker
  // who uploads from the Résumé tab before finishing the interview, then
  // carries on in the tab.
  testWidgets('an upload ENTRY outside the chat never answers a later prompt',
      (WidgetTester tester) async {
    final GoRouter router = GoRouter(
      initialLocation: '/tab',
      routes: <RouteBase>[
        GoRoute(
          path: '/tab',
          builder: (BuildContext context, GoRouterState _) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () => openResumeUploadEntry(context),
                child: const Text('ENTRY'),
              ),
            ),
          ),
        ),
        // Where an entry's attempt lands (owner ruling 2026-10-16). The same
        // screen the tab hosts; built plain here, because the signal's
        // consumer is the screen and not the tab's companion wiring.
        GoRoute(
          path: '/bada-bhai',
          builder: (BuildContext _, GoRouterState __) =>
              const ChatProfilingScreen(),
        ),
        // The production mapping (router.dart), both markers.
        GoRoute(
          path: '/resume-upload',
          builder: (BuildContext _, GoRouterState state) => ResumeUploadScreen(
            autoUpload: state.extra is ResumeUploadAutoIntent,
            directUpload: state.extra is ResumeUploadDirectIntent,
          ),
        ),
      ],
    );
    addTearDown(router.dispose);
    tester.view.physicalSize = const Size(420, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();

    await tester.tap(find.text('ENTRY'));
    await tester.pumpAndSettle();
    // The picker opened by itself, the import finished, and the screen left.
    await tester.pumpAndSettle();
    expect(find.byType(ChatProfilingScreen), findsOneWidget,
        reason: 'precondition: the import ran and handed over to the tab');
    expect(
      router.routerDelegate.currentConfiguration.matches.last.matchedLocation,
      '/bada-bhai',
    );

    // The chat's own next turn brings the résumé prompt — which is precisely
    // the moment a stray signal would be spent.
    await reachThePrompt(tester);
    await tester.pumpAndSettle();

    expect(find.text(kResumePromptNoResumeLabel), findsOneWidget,
        reason: 'the prompt was answered by an upload made somewhere else');
    expect(find.text('Aap kis state mein rehte hain?'), findsNothing,
        reason: 'the stashed question is released only by an answer');
    expect(locator<ResumeImportSignal>().consume(), isFalse);
  });
}

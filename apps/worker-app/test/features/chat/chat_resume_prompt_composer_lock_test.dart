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
  Future<ResumeImportOutcome> importResume(
    PickedResumeDocument document,
  ) async => outcome;
}

/// OWNER ASK (2026-10-15, `issue4`) — "Resume hai aapke paas?" is answered by
/// its two chips ONLY: while it stands there is no text field and no mic.
/// Driven through the real screen and router, from the name answer onwards.
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
    when(
      () => repo.loadHistory(),
    ).thenAnswer((_) async => const <ChatMessage>[]);
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
        builder: (BuildContext _, GoRouterState state) => ChatProfilingScreen(
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

  testWidgets('the résumé prompt withholds the text field and the mic', (
    WidgetTester tester,
  ) async {
    await pumpApp(tester);
    expect(
      find.byType(TextField),
      findsOneWidget,
      reason: 'precondition: the name question is typed',
    );

    await reachThePrompt(tester);

    expect(
      find.byType(TextField),
      findsNothing,
      reason: 'issue4: no text box on the résumé prompt',
    );
    expect(
      find.byIcon(Icons.mic),
      findsNothing,
      reason: 'issue4: no mic on the résumé prompt',
    );
    expect(
      find.text(kChatOptionsOnlyHint),
      findsOneWidget,
      reason: 'the locked bar points at the two chips',
    );
    expect(find.text(kResumePromptUploadLabel), findsOneWidget);
    expect(find.text(kResumePromptNoResumeLabel), findsOneWidget);
  });

  testWidgets(
    '"Mere paas resume nahi hai" brings the composer back for the next question',
    (WidgetTester tester) async {
      // The question stashed behind the prompt is a typed one.
      when(
        () => repo.sendMessage(any(), submissionId: any(named: 'submissionId')),
      ).thenAnswer(
        (_) async => const ChatTurn(reply: 'Aap kya kaam karte hain?'),
      );
      await pumpApp(tester);
      await reachThePrompt(tester);

      // The chip row scrolls sideways; the second chip starts partly off screen.
      await tester.ensureVisible(find.text(kResumePromptNoResumeLabel));
      await tester.pumpAndSettle();
      await tester.tap(find.text(kResumePromptNoResumeLabel));
      await tester.pumpAndSettle();

      // The chips are gone (the label stays only as the worker's own answer).
      expect(find.text(kResumePromptUploadLabel), findsNothing);
      expect(find.text('Aap kya kaam karte hain?'), findsOneWidget);
      expect(find.text(kChatOptionsOnlyHint), findsNothing);
      expect(
        find.byType(TextField),
        findsOneWidget,
        reason: 'the next question is typed again',
      );
      expect(find.byIcon(Icons.mic), findsWidgets);
    },
  );

  test(
    'only the prompt\'s OWN chip pair locks — not the post-profile résumé menu',
    () {
      expect(
        isResumePromptChips(<String>[
          kResumePromptUploadKey,
          kResumePromptNoResumeKey,
        ]),
        isTrue,
      );
      expect(isResumePromptChips(<String>[kResumePromptUploadKey]), isFalse);
      expect(
        isResumePromptChips(<String>[
          kResumePromptUploadKey,
          'resume_form_create',
        ]),
        isFalse,
      );
      expect(isResumePromptChips(const <String>[]), isFalse);
    },
  );
}

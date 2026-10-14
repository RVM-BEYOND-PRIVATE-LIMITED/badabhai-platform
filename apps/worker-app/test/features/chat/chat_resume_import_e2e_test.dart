import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/session/resume_import_signal.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_identity_questions.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_resume_prompt.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_session_opening.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// ── END TO END: THE RÉSUMÉ PROMPT DOES NOT COME BACK AFTER AN UPLOAD ───────
///
/// The device bug, through the REAL screen and the REAL locator — not the
/// pieces in isolation. Two earlier fixes passed their own unit tests and still
/// failed on the phone, both times because a guard was never exercised:
///   1. the first hung off a new bloc that `go()` does create — but the prompt
///      then came back on the next turn anyway;
///   2. the second hung off `widget.fromResumeImport`, which rides the route
///      extra, which the upload cubit sets from `cameFromImport` — FALSE on an
///      import that learned nothing, on uploads-unavailable and on a failed
///      read. Exactly the branches where it mattered.
///
/// So this drives the screen the way the app does and asserts what the worker
/// sees.
void main() {
  late MockChatRepository repo;

  setUp(() async {
    repo = MockChatRepository();
    await locator.reset();
    locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
    locator.registerLazySingleton<ResumeImportSignal>(() => ResumeImportSignal());
    // The chat opens on the first-name question — the turn the prompt rides.
    when(() => repo.ensureSession()).thenAnswer(
      (_) async => const ChatSessionOpening(
        text: 'Aapka pehla naam kya hai?',
        questionKey: kChatFirstNameQuestionKey,
      ),
    );
    when(() => repo.loadHistory()).thenAnswer((_) async => const []);
    when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
    // Answering the name returns the state question — the turn the client
    // STASHES behind the résumé prompt.
    when(() => repo.sendMessage(any(), submissionId: any(named: 'submissionId')))
        .thenAnswer((_) async => const ChatTurn(
              reply: 'Aap kis state mein rehte hain?',
              askedQuestionId: kChatStateQuestionKey,
            ));
  });

  tearDown(() async => locator.reset());

  Future<void> pumpChat(WidgetTester tester, {bool fromResumeImport = false}) async {
    tester.view.physicalSize = const Size(420, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(home: ChatProfilingScreen(fromResumeImport: fromResumeImport)),
    );
    await tester.pumpAndSettle();
  }

  Future<void> answerName(WidgetTester tester) async {
    await tester.enterText(find.byType(TextField), 'Rishi Ojha');
    await tester.testTextInput.receiveAction(TextInputAction.send);
    await tester.pumpAndSettle();
  }

  testWidgets('the prompt appears normally when no upload happened',
      (WidgetTester tester) async {
    await pumpChat(tester);
    await answerName(tester);

    // Baseline: this is the behaviour the fix must NOT break.
    expect(find.text(kResumePromptUploadLabel), findsOneWidget);
    expect(find.text(kResumePromptNoResumeLabel), findsOneWidget);
  });

  testWidgets(
      'after a completed upload the prompt is answered and the stashed '
      'question is shown — WITHOUT the route extra', (WidgetTester tester) async {
    // The upload cubit raised this on its way out. Deliberately pumping with
    // fromResumeImport FALSE: that is the branch the device hit (an import that
    // learned nothing / was unavailable / failed to read), and the fix must
    // work there.
    locator<ResumeImportSignal>().markCompleted();

    await pumpChat(tester);
    await answerName(tester);

    // The prompt's CHIPS are gone...
    expect(find.text(kResumePromptNoResumeLabel), findsNothing);
    // ...the door walked through is shown as the worker's own answer...
    expect(find.text(kResumePromptUploadLabel), findsWidgets);
    // ...and the question that was stashed behind it is now on screen.
    expect(find.text('Aap kis state mein rehte hain?'), findsOneWidget);
  });

  testWidgets('the signal is spent — a later prompt is NOT auto-answered',
      (WidgetTester tester) async {
    locator<ResumeImportSignal>().markCompleted();
    await pumpChat(tester);
    await answerName(tester);
    expect(find.text(kResumePromptNoResumeLabel), findsNothing);

    // A fresh chat with no new upload must ask again.
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpAndSettle();
    await pumpChat(tester);
    await answerName(tester);

    expect(find.text(kResumePromptNoResumeLabel), findsOneWidget,
        reason: 'one upload answers one prompt, not every prompt after it');
  });
}

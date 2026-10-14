import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_models.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_identity_questions.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_message.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_repository.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_turn.dart';
import 'package:badabhai_worker_app/features/chat/domain/chat_year_questions.dart';
import 'package:badabhai_worker_app/features/chat/presentation/bloc/chat_bloc.dart';
import 'package:badabhai_worker_app/features/chat/presentation/chat_profiling_screen.dart';
import 'package:badabhai_worker_app/features/chat/presentation/widgets/chat_year_card.dart';

class MockChatRepository extends Mock implements ChatRepository {}

/// ── `date_issue.jpeg`: "Training kis saal ki thi?" ACCEPTED 2050 ──────────
///
/// The pack serves `training_year` as `answer_type: "number"`, which on the
/// client only swapped the keyboard. Nothing — pack, server or app — bounded
/// the value, so an impossible year was typed, accepted and written.
void main() {
  group('the year question vocabulary', () {
    test('only a CALENDAR-year question gets the picker', () {
      expect(isChatYearQuestion(kChatTrainingYearQuestionKey), isTrue);
      // A DURATION. 5 is right here and 2026 is not — the opposite bug.
      expect(isChatYearQuestion('experience_years'), isFalse);
      expect(isChatYearQuestion(kChatStateQuestionKey), isFalse);
      expect(isChatYearQuestion(null), isFalse);
    });

    test('the list stops at today and reaches the living-memory floor', () {
      final List<int> years =
          chatYearOptions(now: DateTime(2026, 10, 13));
      expect(years.first, 2026, reason: 'newest first, never the future');
      expect(years.last, kChatYearMin);
      expect(years, isNot(contains(2027)));
      expect(years, isNot(contains(2050)), reason: 'date_issue.jpeg');
      expect(years, isNot(contains(1949)));
    });
  });

  group('the year turn on the real screen', () {
    late MockChatRepository repo;

    setUp(() async {
      repo = MockChatRepository();
      await locator.reset();
      locator.registerFactory<ChatBloc>(() => ChatBloc(repo));
      // No identity intake on this session, so no résumé prompt stands between
      // the answer and the year turn.
      when(() => repo.ensureSession()).thenAnswer((_) async => null);
      when(() => repo.loadHistory())
          .thenAnswer((_) async => const <ChatMessage>[]);
      when(() => repo.latestSessionId()).thenAnswer((_) async => 's1');
      when(
        () => repo.sendMessage(
          any(),
          submissionId: any(named: 'submissionId'),
          answerSource: any(named: 'answerSource'),
        ),
      ).thenAnswer(
        (_) async => const ChatTurn(
          reply: 'Training kis saal ki thi?',
          askedQuestionId: kChatTrainingYearQuestionKey,
          answerType: ChatAnswerType.number,
        ),
      );
    });

    tearDown(() async => locator.reset());

    Future<void> reachTheYearTurn(WidgetTester tester) async {
      tester.view.physicalSize = const Size(420, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        const MaterialApp(home: ChatProfilingScreen()),
      );
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField), 'fitter');
      await tester.testTextInput.receiveAction(TextInputAction.send);
      await tester.pumpAndSettle();
    }

    testWidgets('the text box that accepted 2050 is withdrawn',
        (WidgetTester tester) async {
      await reachTheYearTurn(tester);

      expect(find.text('Training kis saal ki thi?'), findsOneWidget);
      expect(find.byType(TextField), findsNothing,
          reason: 'no live-looking box may invite a typed year');
      expect(find.text(kChatYearComposerHint), findsOneWidget);
      expect(find.byKey(kChatYearPickCtaKey), findsOneWidget);
    });

    testWidgets('the picker offers no impossible year, and sends the choice',
        (WidgetTester tester) async {
      await reachTheYearTurn(tester);

      await tester.tap(find.byKey(kChatYearPickCtaKey));
      await tester.pumpAndSettle();

      final int thisYear = DateTime.now().year;
      expect(find.text('${thisYear + 1}'), findsNothing);
      expect(find.text('2050'), findsNothing, reason: 'date_issue.jpeg');
      expect(find.text('$kChatYearMin'), findsOneWidget);

      await tester.tap(find.text('${thisYear - 6}'));
      await tester.pumpAndSettle();

      // Submitted as ordinary chat text — byte-identical to typing it, so the
      // server sees the answer it always did.
      verify(
        () => repo.sendMessage(
          '${thisYear - 6}',
          submissionId: any(named: 'submissionId'),
          // D7 — picker-composed, like the location dialog's answer.
          answerSource: ChatAnswerSource.dialog,
        ),
      ).called(1);
    });
  });
}

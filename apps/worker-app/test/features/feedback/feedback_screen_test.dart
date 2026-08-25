import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_category.dart';
import 'package:badabhai_worker_app/features/feedback/domain/feedback_repository.dart';
import 'package:badabhai_worker_app/features/feedback/presentation/feedback_screen.dart';

class _MockFeedbackRepository extends Mock implements FeedbackRepository {}

void main() {
  late _MockFeedbackRepository repo;

  setUpAll(() => registerFallbackValue(FeedbackCategory.other));

  setUp(() async {
    await locator.reset();
    repo = _MockFeedbackRepository();
    locator.registerFactory<FeedbackRepository>(() => repo);
  });

  tearDown(() => locator.reset());

  Future<GoRouter> pump(WidgetTester tester) async {
    final GoRouter router = GoRouter(
      initialLocation: '/home',
      routes: <RouteBase>[
        GoRoute(
          path: '/home',
          builder: (_, __) => Scaffold(
            body: Builder(
              builder: (BuildContext c) => TextButton(
                onPressed: () => c.push('/feedback'),
                child: const Text('OPEN'),
              ),
            ),
          ),
        ),
        GoRoute(
            path: '/feedback', builder: (_, __) => const FeedbackScreen()),
      ],
    );
    await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router));
    await tester.tap(find.text('OPEN'));
    await tester.pumpAndSettle();
    return router;
  }

  testWidgets('free text + optional category → posts and pops with a thank-you',
      (WidgetTester tester) async {
    when(() => repo.submit(
            message: any(named: 'message'),
            category: any(named: 'category')))
        .thenAnswer((_) async => FeedbackSubmitOutcome.sent);

    final GoRouter router = await pump(tester);

    await tester.enterText(find.byType(TextField), 'App bahut accha hai');
    await tester.pump();
    await tester.tap(find.text('Dikkat')); // optional category
    await tester.pump();

    await tester.tap(find.text('Bhejein'));
    await tester.pumpAndSettle();

    verify(() => repo.submit(
        message: 'App bahut accha hai',
        category: FeedbackCategory.problem)).called(1);
    // Popped back to home + a thank-you snackbar.
    expect(router.routerDelegate.currentConfiguration.uri.toString(), '/home');
    expect(find.textContaining('Shukriya'), findsOneWidget);
  });

  testWidgets('an UNtagged message still submits (category never forced)',
      (WidgetTester tester) async {
    when(() => repo.submit(
            message: any(named: 'message'),
            category: any(named: 'category')))
        .thenAnswer((_) async => FeedbackSubmitOutcome.sent);

    await pump(tester);
    await tester.enterText(find.byType(TextField), 'seedha likha');
    await tester.pump();
    await tester.tap(find.text('Bhejein'));
    await tester.pumpAndSettle();

    verify(() => repo.submit(message: 'seedha likha', category: null))
        .called(1);
  });

  testWidgets('a failed submit keeps the text and shows the honest reason',
      (WidgetTester tester) async {
    when(() => repo.submit(
            message: any(named: 'message'),
            category: any(named: 'category')))
        .thenThrow(const NetworkFailure());

    await pump(tester);
    await tester.enterText(find.byType(TextField), 'kuch dikkat hai');
    await tester.pump();
    await tester.tap(find.text('Bhejein'));
    await tester.pumpAndSettle();

    // Still on the feedback screen, the text is preserved, error surfaced.
    expect(find.byType(FeedbackScreen), findsOneWidget);
    expect(find.text('kuch dikkat hai'), findsOneWidget);
    expect(find.byType(SnackBar), findsOneWidget);
  });
}

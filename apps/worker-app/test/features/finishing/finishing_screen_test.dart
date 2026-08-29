import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_models.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_repository.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/cubit/finishing_cubit.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/finishing_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

class _MockRepo extends Mock implements FinishingRepository {}

const WorkPrefOptionsDto _options = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi', 'english': 'English'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'permanent': 'Permanent'},
  shift: <String, String>{'day': 'Day'},
);

void main() {
  late _MockRepo repo;

  setUpAll(() {
    registerFallbackValue(const WorkPreferences());
    registerFallbackValue(<EmploymentEntry>[]);
  });

  setUp(() async {
    await locator.reset();
    repo = _MockRepo();
    when(() => repo.loadOptions()).thenAnswer((_) async => _options);
    when(() => repo.saveWorkPreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
    locator.registerFactory<FinishingCubit>(() => FinishingCubit(repo));
  });

  tearDown(() => locator.reset());

  Future<GoRouter> pump(WidgetTester tester) async {
    final GoRouter router = GoRouter(
      initialLocation: '/finishing',
      routes: <RouteBase>[
        GoRoute(
            path: '/finishing', builder: (_, __) => const FinishingScreen()),
        GoRoute(
            path: '/building',
            builder: (_, __) => const Scaffold(body: Text('BUILDING'))),
      ],
    );
    await tester.pumpWidget(MaterialApp.router(routerConfig: router));
    await tester.pumpAndSettle();
    return router;
  }

  testWidgets('renders the language chips from the options endpoint',
      (WidgetTester tester) async {
    await pump(tester);
    expect(find.text('Hindi'), findsOneWidget);
    expect(find.text('English'), findsOneWidget);
    // and the advance CTA
    expect(find.text('Aage badhein'), findsOneWidget);
  });

  testWidgets('Aage badhein advances to the next page', (
    WidgetTester tester,
  ) async {
    await pump(tester);
    await tester.tap(find.text('Hindi')); // pick a language
    await tester.pump();
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();
    // page 2 = documents, rendered from options.documents_ready
    expect(find.text('Aadhaar'), findsOneWidget);
  });

  testWidgets('a load failure shows a retry', (WidgetTester tester) async {
    when(() => repo.loadOptions()).thenThrow(Exception('boom'));
    await pump(tester);
    expect(find.text('Dobara koshish karein'), findsWidgets);
  });

  // #1312 — salary is a BAND, not a free-text number.

  Future<void> advance(WidgetTester tester) async {
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();
  }

  WorkPreferences lastSavedPrefs() {
    final List<dynamic> captured =
        verify(() => repo.saveWorkPreferences(captureAny())).captured;
    return captured.last as WorkPreferences;
  }

  testWidgets(
      'choosing a salary band sends its upper bound as salary_expected_max',
      (WidgetTester tester) async {
    await pump(tester);
    // languages → documents → shift/type → cities → salary+education
    for (int i = 0; i < 4; i++) {
      await advance(tester);
    }
    // The ₹15–20 hazaar band — its UPPER bound (20000) is what the wire carries.
    await tester.tap(find.text('₹15–20 hazaar'));
    await tester.pump();
    // salary+education → history, then finish
    await advance(tester);
    await tester.tap(find.text('Ho gaya'));
    await tester.pumpAndSettle();

    final WorkPreferences prefs = lastSavedPrefs();
    expect(prefs.salaryExpectedMax, 20000);
    expect(prefs.toUpdateBody()['salary_expected_max'], 20000);
  });

  testWidgets('skipping the salary page sends no salary_expected_max key',
      (WidgetTester tester) async {
    await pump(tester);
    // Walk every page without touching the band picker, then submit.
    for (int i = 0; i < 5; i++) {
      await advance(tester);
    }
    await tester.tap(find.text('Ho gaya'));
    await tester.pumpAndSettle();

    final WorkPreferences prefs = lastSavedPrefs();
    expect(prefs.salaryExpectedMax, isNull);
    // The wire key must stay ABSENT (not 0) — the server field is optional.
    expect(prefs.toUpdateBody().containsKey('salary_expected_max'), isFalse);
  });

  testWidgets('re-tapping the chosen band clears it (a real skip)',
      (WidgetTester tester) async {
    await pump(tester);
    for (int i = 0; i < 4; i++) {
      await advance(tester);
    }
    await tester.tap(find.text('₹15–20 hazaar'));
    await tester.pump();
    // Tap the same band again — it deselects, so no salary is sent.
    await tester.tap(find.text('₹15–20 hazaar'));
    await tester.pump();
    await advance(tester);
    await tester.tap(find.text('Ho gaya'));
    await tester.pumpAndSettle();

    final WorkPreferences prefs = lastSavedPrefs();
    expect(prefs.salaryExpectedMax, isNull);
    expect(prefs.toUpdateBody().containsKey('salary_expected_max'), isFalse);
  });
}

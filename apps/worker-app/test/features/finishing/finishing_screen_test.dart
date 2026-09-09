import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_models.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_repository.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/cubit/finishing_cubit.dart';
import 'package:badabhai_worker_app/features/voice_form/presentation/widgets/voice_dot_rail.dart';
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
    // languages → documents → shift/type → cities → SALARY (#1471: salary,
    // education and education-detail are three pages now, not one).
    for (int i = 0; i < 4; i++) {
      await advance(tester);
    }
    // The ₹15–20 hazaar band — its UPPER bound (20000) is what the wire carries.
    await tester.tap(find.text('₹15–20 hazaar'));
    await tester.pump();
    // salary → education → education detail → history, then finish
    for (int i = 0; i < 3; i++) {
      await advance(tester);
    }
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
    for (int i = 0; i < FinishingPage.values.length - 1; i++) {
      await advance(tester);
    }
    await tester.tap(find.text('Ho gaya'));
    await tester.pumpAndSettle();

    final WorkPreferences prefs = lastSavedPrefs();
    expect(prefs.salaryExpectedMax, isNull);
    // The wire key must stay ABSENT (not 0) — the server field is optional.
    expect(prefs.toUpdateBody().containsKey('salary_expected_max'), isFalse);
  });

  // #1471 — the reported bug. "Salary aur padhai" put FIVE questions on one
  // page (salary band, credential, council, year, institute), so the worker had
  // to scroll a form they cannot read to reach the button. Three pages now, one
  // idea each, and each must FIT a real handset without scrolling.
  group('salary and padhai are three pages that fit (#1471)', () {
    /// Every page of the wizard, in order, with the reported handset's size.
    Future<void> pumpAtPage(WidgetTester tester, int page) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3.0; // 360 x 800 logical — a real phone
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await pump(tester);
      for (int i = 0; i < page; i++) {
        await advance(tester);
      }
    }

    /// The body scrolls only when its content is taller than its viewport.
    bool bodyOverflows(WidgetTester tester) {
      final ScrollableState sc = tester.state<ScrollableState>(
          find.byType(Scrollable).last);
      return sc.position.maxScrollExtent > 0;
    }

    testWidgets('the salary page asks ONLY the money question',
        (WidgetTester tester) async {
      await pumpAtPage(tester, 4);

      expect(find.text('Mahine ki salary'), findsOneWidget); // header
      expect(find.text('₹15–20 hazaar'), findsOneWidget);
      // The education questions have moved off this page entirely.
      expect(find.text('Agar ITI ya Diploma hai to kaun sa?'), findsNothing);
      expect(find.text('Council / board'), findsNothing);
      expect(find.text('Institute ka naam'), findsNothing);
      expect(bodyOverflows(tester), isFalse,
          reason: 'the salary page must not need scrolling');
    });

    testWidgets('the education page asks the two CHIP questions',
        (WidgetTester tester) async {
      await pumpAtPage(tester, 5);

      expect(find.text('ITI ya Diploma'), findsOneWidget); // header
      expect(find.text('Agar ITI ya Diploma hai to kaun sa?'), findsOneWidget);
      expect(find.text('Council / board'), findsOneWidget);
      // No money, no keyboard fields.
      expect(find.text('₹15–20 hazaar'), findsNothing);
      expect(find.text('Institute ka naam'), findsNothing);
      // HONEST RESIDUAL. `council` has EIGHT options and the wizard chrome
      // (blue header + dot rail + sticky button) leaves only ~486dp of body on
      // a 360x800 handset, so this one page still needs a short flick — about
      // 170dp, one thumb. It was FIVE questions deep before the split. Bounded
      // here so it cannot quietly grow again; removing the flick entirely means
      // either giving `council` its own page (four, not three) or turning it
      // into a picker, and both are the owner's call.
      final ScrollableState sc =
          tester.state<ScrollableState>(find.byType(Scrollable).last);
      expect(sc.position.maxScrollExtent, lessThan(200),
          reason: 'the education page must stay within one short flick');
    });

    testWidgets('the detail page holds the two TEXT fields, and only those',
        (WidgetTester tester) async {
      await pumpAtPage(tester, 6);

      expect(find.text('Padhai ki detail'), findsOneWidget); // header
      expect(find.text('Kis saal poora hua'), findsWidgets);
      expect(find.text('Institute ka naam'), findsWidgets);
      expect(find.text('₹15–20 hazaar'), findsNothing);
      expect(find.text('Council / board'), findsNothing);
      expect(bodyOverflows(tester), isFalse,
          reason: 'the education-detail page must not need scrolling');
    });

    testWidgets('the dot rail counts all eight pages', (WidgetTester tester) async {
      await pumpAtPage(tester, 4);
      expect(FinishingPage.values.length, 8);
      final VoiceDotRail rail =
          tester.widget<VoiceDotRail>(find.byType(VoiceDotRail));
      expect(rail.total, 8);
      expect(rail.filled, 5); // page index 4
    });

    testWidgets('every answer still reaches the wire from its new page',
        (WidgetTester tester) async {
      await pumpAtPage(tester, 4);
      await tester.tap(find.text('₹15–20 hazaar')); // salary page
      await tester.pump();
      await advance(tester);
      await tester.tap(find.text('ITI')); // education page
      await tester.pump();
      await advance(tester);
      await tester.enterText(find.byType(TextField).first, '2018'); // detail
      await tester.pump();
      await advance(tester);
      await tester.tap(find.text('Ho gaya'));
      await tester.pumpAndSettle();

      final WorkPreferences prefs = lastSavedPrefs();
      expect(prefs.salaryExpectedMax, 20000);
      expect(prefs.educationCredential, isNotNull);
      expect(prefs.educationYear, 2018);
    });
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
    for (int i = 0; i < 3; i++) {
      await advance(tester);
    }
    await tester.tap(find.text('Ho gaya'));
    await tester.pumpAndSettle();

    final WorkPreferences prefs = lastSavedPrefs();
    expect(prefs.salaryExpectedMax, isNull);
    expect(prefs.toUpdateBody().containsKey('salary_expected_max'), isFalse);
  });
}

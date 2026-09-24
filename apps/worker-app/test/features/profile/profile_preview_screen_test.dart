// #844 — the profile CONFIRM screen ("Yeh sahi hai?") must NOT render the
// "Profile strength" row. A completeness score is not an input to "is this
// information correct?", and a low number (the 4/9 that prompted this) reads
// like a failing grade at the moment we want a simple yes. The strength card
// still lives on the Profile TAB (profile_tab_screen_test.dart) and `strength*`
// stay on ProfileSummary — this lock is only about the confirm step.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bottom_bar_inset.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/profile/presentation/cubit/profile_cubit.dart';
import 'package:badabhai_worker_app/features/profile/presentation/profile_preview_screen.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_models.dart';
import 'package:badabhai_worker_app/features/trade_form/domain/trade_form_repository.dart';
import 'package:badabhai_worker_app/router.dart';

class MockProfileRepository extends Mock implements ProfileRepository {}

class MockProfileSummaryRepository extends Mock
    implements ProfileSummaryRepository {}

class MockTradeFormRepository extends Mock implements TradeFormRepository {}

Future<void> _pump(WidgetTester tester, ProfileSummary summary) =>
    _pumpScreen(tester, summary: () async => summary);

/// Mounts the screen with the extraction / summary reads answered by the given
/// callbacks (throw a [Failure] from either to reach the failed state or the
/// summary-miss view), on a [size] viewport at [textScale].
Future<void> _pumpScreen(
  WidgetTester tester, {
  Future<String> Function()? extract,
  required Future<ProfileSummary> Function() summary,
  Size size = const Size(900, 1900),
  double textScale = 1.0,
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  final MockProfileRepository repo = MockProfileRepository();
  final MockProfileSummaryRepository summaryRepo = MockProfileSummaryRepository();
  when(() => repo.extractProfile())
      .thenAnswer((_) => extract == null ? Future<String>.value('p1') : extract());
  when(() => summaryRepo.summary()).thenAnswer((_) => summary());
  locator.registerFactory<ProfileCubit>(() => ProfileCubit(repo, summaryRepo));

  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1.0;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

  await tester.pumpWidget(
    MaterialApp(theme: AppTheme.light(), home: const ProfilePreviewScreen()),
  );
  await tester.pump(); // extracting
  await tester.pump(); // extractProfile future resolves
  await tester.pump(); // summary future resolves → ready
}

void main() {
  tearDown(() async => locator.reset());

  testWidgets(
    'the confirm screen shows Trade / City and the confirm actions, and NO '
    'Profile strength row (#844)',
    (WidgetTester tester) async {
      // The 4/9 shape from the screenshot that prompted the removal.
      await _pump(
        tester,
        const ProfileSummary(
          tradeLabel: 'Welder',
          city: 'Pune',
          strengthSignals: 4,
          strengthMax: 9,
        ),
      );

      // The confirm step itself renders.
      expect(find.text('Yeh sahi hai?'), findsOneWidget);
      expect(find.text('Haan, sahi hai'), findsOneWidget);
      expect(find.text('Badlo'), findsOneWidget);

      // The data rows the worker confirms stay.
      expect(find.text('TRADE'), findsOneWidget);
      expect(find.text('Welder'), findsOneWidget);
      expect(find.text('CITY'), findsOneWidget);
      expect(find.text('Pune'), findsOneWidget);

      // The strength row is gone — no label, no "N/max cheezein complete", no
      // bare "4/9" grade.
      expect(find.text('Profile strength'), findsNothing);
      expect(find.textContaining('cheezein complete'), findsNothing);
      expect(find.textContaining('4/9'), findsNothing);
    },
  );

  // ---- Master UI Kit layout ---------------------------------------------------
  //
  // The kit redesign moved this screen off BbScaffold onto a raw Scaffold with a
  // Shift Blue header and a docked QuestionnaireBottomBar. These lock the two
  // things BbScaffold used to give for free: every status view fits (scrolls) on
  // the smallest supported phone at a 2.0 system font, and the docked confirm
  // bar still publishes its height so the Feedback FAB floats clear (#1071).
  group('kit layout', () {
    tearDown(() => bottomBarInset.value = 0);

    const Size kSmallPhone = Size(320, 568);
    const ProfileSummary kLongReady = ProfileSummary(
      tradeLabel: 'CNC operator and VMC setter with programming experience',
      city: 'Pimpri-Chinchwad, Pune district',
      educationLevel: 'iti',
      educationField: 'Machinist and fitter, two year course',
      strengthSignals: 0,
    );

    testWidgets('ready (all rows) fits 320x568 at 2.0 text scale',
        (WidgetTester tester) async {
      await _pumpScreen(tester,
          summary: () async => kLongReady,
          size: kSmallPhone,
          textScale: 2.0);

      expect(tester.takeException(), isNull);
      expect(find.text('Yeh sahi hai?'), findsOneWidget);
      expect(find.text('Haan, sahi hai'), findsOneWidget);
      expect(find.text('Badlo'), findsOneWidget);
    });

    testWidgets('summary-miss ready view fits 320x568 at 2.0 text scale',
        (WidgetTester tester) async {
      await _pumpScreen(tester,
          summary: () async => throw const NetworkFailure(),
          size: kSmallPhone,
          textScale: 2.0);

      expect(tester.takeException(), isNull);
      expect(find.text('PROFILE'), findsOneWidget);
      expect(find.text('Ready'), findsOneWidget);
    });

    testWidgets(
        'failed view fits 320x568 at 2.0 text scale, keeps both ways out, and '
        'shows no confirm bar', (WidgetTester tester) async {
      await _pumpScreen(tester,
          extract: () async => throw const NetworkFailure(),
          summary: () async => kLongReady,
          size: kSmallPhone,
          textScale: 2.0);

      expect(tester.takeException(), isNull);
      expect(find.text('Your profile'), findsOneWidget);
      expect(find.text('Profile taiyaar nahi ho payi.'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);
      expect(find.text('Chat pe wapas jaayein'), findsOneWidget);
      expect(find.text('Haan, sahi hai'), findsNothing);
    });

    testWidgets(
        'draft view fits 320x568 at 2.0 text scale and offers no confirm (#503)',
        (WidgetTester tester) async {
      await _pumpScreen(tester,
          summary: () async => const ProfileSummary(
                tradeLabel: 'Welder',
                strengthSignals: 0,
                profileStatus: 'draft',
              ),
          size: kSmallPhone,
          textScale: 2.0);

      expect(tester.takeException(), isNull);
      expect(find.text('Thodi aur detail chahiye.'), findsOneWidget);
      expect(find.text('Chat pe wapas jaayein'), findsOneWidget);
      expect(find.text('Haan, sahi hai'), findsNothing);
      expect(find.text('Badlo'), findsNothing);
    });

    testWidgets(
        'the docked confirm bar publishes its height for the Feedback FAB '
        '(#1071)', (WidgetTester tester) async {
      await _pumpScreen(tester, summary: () async => kLongReady);

      expect(find.text('Haan, sahi hai'), findsOneWidget);
      expect(bottomBarInset.value, greaterThan(0));
    });

    testWidgets(
        'a view without the confirm bar publishes 0, never a stale height '
        '(#1071)', (WidgetTester tester) async {
      bottomBarInset.value = 999; // a stale height left by some other page
      await _pumpScreen(tester,
          extract: () async => throw const NetworkFailure(),
          summary: () async => kLongReady);

      expect(find.text('Try again'), findsOneWidget);
      expect(bottomBarInset.value, 0);
    });
  });

  // ---- #1344 (scoped retirement) — post-confirm routing --------------------
  //
  // Full navigation coverage, via a REAL GoRouter (mirrors
  // chat_form_offer_test.dart's `pumpChat`): mount ProfilePreviewScreen at
  // Routes.profilePreview alongside marker screens for Routes.finishing and
  // Routes.tradeForm, tap "Haan, sahi hai", and assert which marker the app
  // actually lands on.
  group('#1344 post-confirm routing', () {
    const String kFinishingMarker = 'FINISHING-SCREEN';
    const String kTradeFormMarker = 'TRADE-FORM-SCREEN';
    const String kBuildingMarker = 'BUILDING-SCREEN';

    const TradeForm kSomeTradeForm = TradeForm(
      kind: 'cnc_turner',
      packId: 'pack-1',
      packVersion: 1,
      sections: <TradeFormSection>[],
    );

    Future<void> pumpConfirmable(
      WidgetTester tester, {
      required TradeFormRepository tradeFormRepo,
      String? next,
    }) async {
      GoogleFonts.config.allowRuntimeFetching = false;
      await locator.reset();
      final MockProfileRepository repo = MockProfileRepository();
      final MockProfileSummaryRepository summaryRepo =
          MockProfileSummaryRepository();
      when(() => repo.extractProfile()).thenAnswer((_) async => 'p1');
      when(() => summaryRepo.summary()).thenAnswer(
        (_) async => const ProfileSummary(
          tradeLabel: 'Welder',
          city: 'Pune',
          strengthSignals: 4,
        ),
      );
      when(() => repo.confirmProfile()).thenAnswer((_) async => next);
      locator.registerFactory<ProfileCubit>(
        () => ProfileCubit(repo, summaryRepo, tradeFormRepo: tradeFormRepo),
      );

      tester.view.physicalSize = const Size(900, 1900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final GoRouter router = GoRouter(
        initialLocation: Routes.profilePreview,
        routes: <RouteBase>[
          GoRoute(
            path: Routes.profilePreview,
            builder: (_, __) => const ProfilePreviewScreen(),
          ),
          GoRoute(
            path: Routes.finishing,
            builder: (_, __) => const Scaffold(body: Text(kFinishingMarker)),
          ),
          GoRoute(
            path: Routes.tradeForm,
            builder: (_, __) => const Scaffold(body: Text(kTradeFormMarker)),
          ),
          GoRoute(
            path: Routes.building,
            builder: (_, __) => const Scaffold(body: Text(kBuildingMarker)),
          ),
        ],
      );
      await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
      );
      await tester.pump(); // extracting
      await tester.pump(); // extractProfile future resolves
      await tester.pump(); // summary future resolves → ready

      await tester.tap(find.text('Haan, sahi hai'));
      await tester.pumpAndSettle();
    }

    testWidgets(
        'a covered trade (loadForm returns a real form) routes to '
        'Routes.tradeForm', (WidgetTester tester) async {
      final MockTradeFormRepository tradeFormRepo = MockTradeFormRepository();
      when(() => tradeFormRepo.loadForm())
          .thenAnswer((_) async => kSomeTradeForm);

      await pumpConfirmable(tester, tradeFormRepo: tradeFormRepo);

      expect(find.text(kTradeFormMarker), findsOneWidget);
      expect(find.text(kFinishingMarker), findsNothing);
    });

    testWidgets(
        'an uncovered trade (loadForm returns null / 404) routes to '
        'Routes.finishing — BYTE-IDENTICAL to the pre-#1344 destination',
        (WidgetTester tester) async {
      final MockTradeFormRepository tradeFormRepo = MockTradeFormRepository();
      when(() => tradeFormRepo.loadForm()).thenAnswer((_) async => null);

      await pumpConfirmable(tester, tradeFormRepo: tradeFormRepo);

      expect(find.text(kFinishingMarker), findsOneWidget);
      expect(find.text(kTradeFormMarker), findsNothing);
    });

    testWidgets(
        'the routing check throwing FAILS SAFE to Routes.finishing — the '
        'worker is never stranded on a spinner or an error screen',
        (WidgetTester tester) async {
      final MockTradeFormRepository tradeFormRepo = MockTradeFormRepository();
      when(() => tradeFormRepo.loadForm())
          .thenThrow(const NetworkFailure());

      await pumpConfirmable(tester, tradeFormRepo: tradeFormRepo);

      expect(find.text(kFinishingMarker), findsOneWidget);
      expect(find.text(kTradeFormMarker), findsNothing);
    });

    // #1522 — the server's `next` now wins without a probe.
    testWidgets(
        "next == 'trade_form' routes straight to Routes.tradeForm and skips "
        'the form probe', (WidgetTester tester) async {
      final MockTradeFormRepository tradeFormRepo = MockTradeFormRepository();

      await pumpConfirmable(
        tester,
        tradeFormRepo: tradeFormRepo,
        next: 'trade_form',
      );

      expect(find.text(kTradeFormMarker), findsOneWidget);
      expect(find.text(kFinishingMarker), findsNothing);
      expect(find.text(kBuildingMarker), findsNothing);
      verifyNever(() => tradeFormRepo.loadForm());
    });

    // #1528 — the chat road completes STRAIGHT into résumé building, and must
    // never be rendered through /finishing.
    testWidgets(
        "next == 'chat_complete' routes to Routes.building, NOT /finishing or "
        'the trade form', (WidgetTester tester) async {
      final MockTradeFormRepository tradeFormRepo = MockTradeFormRepository();
      when(() => tradeFormRepo.loadForm())
          .thenAnswer((_) async => kSomeTradeForm);

      await pumpConfirmable(
        tester,
        tradeFormRepo: tradeFormRepo,
        next: 'chat_complete',
      );

      expect(find.text(kBuildingMarker), findsOneWidget);
      expect(find.text(kFinishingMarker), findsNothing);
      expect(find.text(kTradeFormMarker), findsNothing);
      verifyNever(() => tradeFormRepo.loadForm());
    });
  });

  // ---- #1524 — per-source rendering + originating-flow edit --------------
  group('#1524 per-source rendering and edit destination', () {
    const String kChatMarker = 'CHAT-SCREEN';
    const String kTradeFormMarker = 'TRADE-FORM-SCREEN';

    Future<void> pumpForEdit(
      WidgetTester tester, {
      required ProfileSummary summary,
    }) async {
      GoogleFonts.config.allowRuntimeFetching = false;
      await locator.reset();
      final MockProfileRepository repo = MockProfileRepository();
      final MockProfileSummaryRepository summaryRepo =
          MockProfileSummaryRepository();
      when(() => repo.extractProfile()).thenAnswer((_) async => 'p1');
      when(() => summaryRepo.summary()).thenAnswer((_) async => summary);
      locator.registerFactory<ProfileCubit>(
        () => ProfileCubit(repo, summaryRepo),
      );

      tester.view.physicalSize = const Size(900, 1900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final GoRouter router = GoRouter(
        initialLocation: Routes.profilePreview,
        routes: <RouteBase>[
          GoRoute(
            path: Routes.profilePreview,
            builder: (_, __) => const ProfilePreviewScreen(),
          ),
          GoRoute(
            path: Routes.chatProfiling,
            builder: (_, __) => const Scaffold(body: Text(kChatMarker)),
          ),
          GoRoute(
            path: Routes.tradeForm,
            builder: (_, __) => const Scaffold(body: Text(kTradeFormMarker)),
          ),
        ],
      );
      await tester.pumpWidget(
        MaterialApp.router(theme: AppTheme.light(), routerConfig: router),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();
    }

    testWidgets(
        "a CHAT-sourced profile renders the chat variant (heading + chat "
        'facts) and its Badlo returns to the chat', (WidgetTester tester) async {
      await pumpForEdit(
        tester,
        summary: const ProfileSummary(
          tradeLabel: 'Welder',
          strengthSignals: 4,
          experienceYears: 3,
          skills: <String>['Arc welding', 'Gas cutting'],
          source: 'chat',
        ),
      );

      // The chat variant is unmistakably different from the form's sheet.
      expect(find.text(kChatProfileHeading), findsOneWidget);
      expect(find.text('KAAM'), findsOneWidget);
      expect(find.text('ANUBHAV'), findsOneWidget);
      expect(find.text('3 saal'), findsOneWidget);
      expect(find.text('SKILLS'), findsOneWidget);
      expect(find.textContaining('Arc welding'), findsOneWidget);
      // The form road's micro labels are NOT used for a chat profile.
      expect(find.text('TRADE'), findsNothing);
      expect(find.text('CITY'), findsNothing);

      await tester.tap(find.text('Badlo'));
      await tester.pumpAndSettle();

      expect(find.text(kChatMarker), findsOneWidget);
      expect(find.text(kTradeFormMarker), findsNothing);
    });

    testWidgets(
        'a FORM-sourced profile renders the trade-sheet rows and its Badlo '
        'goes to the form, never the chat', (WidgetTester tester) async {
      await pumpForEdit(
        tester,
        summary: const ProfileSummary(
          tradeLabel: 'Welder',
          city: 'Pune',
          educationLevel: 'iti',
          strengthSignals: 4,
          source: 'form',
        ),
      );

      expect(find.text('TRADE'), findsOneWidget);
      expect(find.text('Welder'), findsOneWidget);
      expect(find.text('CITY'), findsOneWidget);
      expect(find.text('EDUCATION'), findsOneWidget);
      // No chat-road marker on the form variant.
      expect(find.text(kChatProfileHeading), findsNothing);

      await tester.tap(find.text('Badlo'));
      await tester.pumpAndSettle();

      expect(find.text(kTradeFormMarker), findsOneWidget);
      expect(find.text(kChatMarker), findsNothing);
    });

    testWidgets(
        'a null source keeps today\'s single rendering (trade rows, no chat '
        'heading)', (WidgetTester tester) async {
      await pumpForEdit(
        tester,
        summary: const ProfileSummary(
          tradeLabel: 'Welder',
          city: 'Pune',
          strengthSignals: 4,
        ),
      );

      expect(find.text('TRADE'), findsOneWidget);
      expect(find.text('Welder'), findsOneWidget);
      expect(find.text('CITY'), findsOneWidget);
      expect(find.text(kChatProfileHeading), findsNothing);
    });
  });

  // ---- #issue5 — add another experience from the chat confirm screen -------
  //
  // The chat road used to show ONE aggregate "Anubhav" and stop, so a worker
  // with several jobs could not record them. The confirm screen now offers the
  // form's own repeated-card editor (same validation, same PUT endpoint).
  group('#issue5 add experience on the chat confirm screen', () {
    Future<MockTradeFormRepository> pumpForExperience(
      WidgetTester tester, {
      String? source = 'chat',
    }) async {
      GoogleFonts.config.allowRuntimeFetching = false;
      await locator.reset();
      final MockProfileRepository repo = MockProfileRepository();
      final MockProfileSummaryRepository summaryRepo =
          MockProfileSummaryRepository();
      final MockTradeFormRepository tradeFormRepo = MockTradeFormRepository();
      when(() => repo.extractProfile()).thenAnswer((_) async => 'p1');
      when(() => summaryRepo.summary()).thenAnswer(
        (_) async => ProfileSummary(
          tradeLabel: 'Welder',
          strengthSignals: 4,
          experienceYears: 3,
          source: source,
        ),
      );
      when(() => tradeFormRepo.loadPreferenceOptions()).thenAnswer(
        (_) async => const WorkPrefOptionsDto(
          languages: <String, String>{},
          documentsReady: <String, String>{},
          jobType: <String, String>{},
          shift: <String, String>{},
        ),
      );
      when(() => tradeFormRepo.saveEmployment(any(), expectedExistingCount: any(named: 'expectedExistingCount'))).thenAnswer((_) async {});
      locator.registerFactory<ProfileCubit>(
        () => ProfileCubit(repo, summaryRepo, tradeFormRepo: tradeFormRepo),
      );

      tester.view.physicalSize = const Size(900, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(
        MaterialApp(
          theme: AppTheme.light(),
          home: const ProfilePreviewScreen(),
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.pump();
      return tradeFormRepo;
    }

    testWidgets('the chat confirm screen offers the add-experience action',
        (WidgetTester tester) async {
      await pumpForExperience(tester);

      expect(find.text('Aur anubhav jodein'), findsOneWidget);
      expect(find.text('Haan, sahi hai'), findsOneWidget);
    });

    testWidgets('the form road does not get the chat add action',
        (WidgetTester tester) async {
      await pumpForExperience(tester, source: 'form');

      expect(find.text('Aur anubhav jodein'), findsNothing);
    });

    testWidgets(
        'adding a job opens the form editor, saves, and shows the new row',
        (WidgetTester tester) async {
      final MockTradeFormRepository tradeFormRepo =
          await pumpForExperience(tester);

      await tester.tap(find.text('Aur anubhav jodein'));
      await tester.pumpAndSettle();

      // The reused form editor, with its own save button.
      expect(find.text('Kaam ka anubhav'), findsOneWidget);
      expect(find.text('Save karein'), findsOneWidget);

      await tester.ensureVisible(find.text('Aur ek jagah jodein'));
      await tester.tap(find.text('Aur ek jagah jodein'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).at(0), 'Acme');
      await tester.enterText(find.byType(TextField).at(1), 'Fitter');
      await tester.enterText(find.byType(TextField).at(2), 'Naye parts banate the');
      await tester.pump();

      // The form's own date rule still applies: a start is required.
      await tester.ensureVisible(find.text('Nahi bataya').first);
      await tester.tap(find.text('Nahi bataya').first);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('2021'));
      await tester.tap(find.text('2021'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Jan'));
      await tester.tap(find.text('Jan'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Save karein'));
      await tester.pumpAndSettle();

      verify(() => tradeFormRepo.saveEmployment(any(), expectedExistingCount: any(named: 'expectedExistingCount'))).called(1);
      // Back on the confirm screen, the added job is visible — the write was
      // not blind.
      expect(find.text('Aur anubhav jodein'), findsOneWidget);
      expect(find.textContaining('Acme'), findsOneWidget);
    });

    testWidgets('a failed save keeps the editor open and names the reason',
        (WidgetTester tester) async {
      final MockTradeFormRepository tradeFormRepo =
          await pumpForExperience(tester);
      when(() => tradeFormRepo.saveEmployment(any(), expectedExistingCount: any(named: 'expectedExistingCount')))
          .thenThrow(const NetworkFailure());

      await tester.tap(find.text('Aur anubhav jodein'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Aur ek jagah jodein'));
      await tester.tap(find.text('Aur ek jagah jodein'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextField).at(0), 'Acme');
      await tester.enterText(find.byType(TextField).at(1), 'Fitter');
      await tester.enterText(find.byType(TextField).at(2), 'Naye parts banate the');
      await tester.pump();
      await tester.ensureVisible(find.text('Nahi bataya').first);
      await tester.tap(find.text('Nahi bataya').first);
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('2021'));
      await tester.tap(find.text('2021'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.text('Jan'));
      await tester.tap(find.text('Jan'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Save karein'));
      await tester.pumpAndSettle();

      // Still on the editor, with the real reason surfaced — never a silent
      // pop that pretends the save worked.
      expect(find.text('Kaam ka anubhav'), findsOneWidget);
      expect(find.byType(SnackBar), findsOneWidget);
    });
  });
}

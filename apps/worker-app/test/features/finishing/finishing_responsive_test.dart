// UI kit v3, decision D13 — the responsive contract for the finishing form
// (the same form-flow chrome the trade form wears: navy header + STEP line,
// progress strip, question headline in the body, option cards, docked bar).
//
// What is pinned here:
//  1. the SIZE × TEXT-SCALE matrix on the first page — nothing throws and the
//     docked "Aage badhein" is on screen without a scroll;
//  2. the WORK-HISTORY page — the only one that types — on a short phone at
//     2.0 with the KEYBOARD UP;
//  3. a TABLET — the option column stops at the kit's form width;
//  4. TAP TARGETS on a real handset;
//  5. D11 — an option slug, a council slug or a salary's raw rupee figure never
//     reaches the glass.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/api/api_client.dart'
    show WorkPrefOptionsDto;
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/form_flow_parts.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_models.dart';
import 'package:badabhai_worker_app/features/finishing/domain/finishing_repository.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/cubit/finishing_cubit.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/finishing_screen.dart';
import 'package:badabhai_worker_app/features/finishing/presentation/widgets/finishing_controls.dart';

import '../../support/kit_matrix.dart';

class _MockRepo extends Mock implements FinishingRepository {}

const String _kNext = 'Aage badhein';
const String _kAddEmployer = 'Aur ek jagah jodein';

const WorkPrefOptionsDto _options = WorkPrefOptionsDto(
  languages: <String, String>{'hindi': 'Hindi', 'english': 'English'},
  documentsReady: <String, String>{'aadhaar': 'Aadhaar'},
  jobType: <String, String>{'permanent': 'Permanent'},
  shift: <String, String>{'day': 'Day'},
);

/// Wire values behind the labels above (plus the education vocabularies and a
/// salary band's raw upper bound). None of them is worker-facing copy.
const List<String> _kWireSlugs = <String>[
  'hindi',
  'english',
  'aadhaar',
  'permanent',
  'iti',
  'ncvt',
  '20000',
];

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
    when(() => repo.loadSessionFill()).thenAnswer((_) async => null);
    when(() => repo.saveWorkPreferences(any())).thenAnswer((_) async {});
    when(() => repo.saveEmployment(any())).thenAnswer((_) async {});
    locator.registerFactory<FinishingCubit>(() => FinishingCubit(repo));
  });

  tearDown(() async => locator.reset());

  /// Pumps the finishing form at [size] and [scale], with an optional
  /// [keyboard] up. No [SpeechReader] is registered, so the docked bar renders
  /// without a listen tile — the same as on a device with no TTS.
  Future<void> pumpForm(
    WidgetTester tester, {
    required Size size,
    required double scale,
    double keyboard = 0,
  }) async {
    setKitSurface(tester, size, keyboard: keyboard);
    final GoRouter router = GoRouter(
      initialLocation: '/finishing',
      routes: <RouteBase>[
        GoRoute(
          path: '/finishing',
          builder: (_, __) => const FinishingScreen(),
        ),
        GoRoute(
          path: '/building',
          builder: (_, __) => const Scaffold(body: Text('BUILDING')),
        ),
      ],
    );
    await tester.pumpWidget(
      MaterialApp.router(
        routerConfig: router,
        builder: (BuildContext context, Widget? child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(scale)),
          child: child ?? const SizedBox.shrink(),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  /// One page forward. `ensureVisible` first: at a 2.0 font the docked bar is
  /// on screen but the page under it may have scrolled the tap target away.
  Future<void> advance(WidgetTester tester) async {
    await tester.ensureVisible(find.text(_kNext));
    await tester.tap(find.text(_kNext));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  group('D13 matrix — every phone shape at every font size', () {
    for (final Size size in kKitMatrixSizes) {
      for (final double scale in kKitMatrixTextScales) {
        testWidgets(
          'the finishing form holds at ${size.width.toInt()}x${size.height.toInt()} @ ${scale}x',
          (WidgetTester tester) async {
            await pumpForm(tester, size: size, scale: scale);

            expect(
              tester.takeException(),
              isNull,
              reason: 'the finishing form threw at $size, text x$scale',
            );
            expect(find.text(_kNext), findsOneWidget);
            // The page's own options came from the options endpoint.
            expect(find.text('Hindi'), findsOneWidget);
          },
        );
      }
    }
  });

  testWidgets(
    'D13 small + keyboard — the work-history page at 320x568 @2.0 with the '
    'keyboard up keeps its card and its docked bar',
    (WidgetTester tester) async {
      await pumpForm(tester, size: const Size(320, 568), scale: 2.0);
      // languages → … → history (the last page, the only one that types).
      for (int i = 0; i < FinishingPage.values.length - 1; i++) {
        await advance(tester);
      }
      expect(tester.takeException(), isNull, reason: 'walking to work history');

      await tester.ensureVisible(find.text(_kAddEmployer));
      await tester.tap(find.text(_kAddEmployer));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // NOW the keyboard comes up — the order a worker meets it: they reach the
      // page that types and tap a field. Raising it before the form has even
      // loaded is a state no device produces.
      tester.view.viewInsets = const FakeViewPadding(bottom: 260);
      addTearDown(tester.view.resetViewInsets);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(
        tester.takeException(),
        isNull,
        reason: 'an open employer card must fit beside the keyboard',
      );
      expect(find.byType(TextField), findsWidgets);
      // "Ho gaya" is the last page's docked action — still there, still docked.
      expect(find.text('Ho gaya'), findsOneWidget);
    },
  );

  testWidgets(
    'the chrome collapses when the keyboard RISES and returns when it '
    'closes',
    (WidgetTester tester) async {
      await pumpForm(tester, size: const Size(320, 568), scale: 2.0);
      expect(
        find.byType(FormProgressStrip),
        findsOneWidget,
        reason: 'the approved drawing, keyboard down',
      );

      // The keyboard arrives AFTER the build that decided the chrome — the case
      // that pins the MediaQuery dependency (a window reading subscribes to
      // nothing, so that build would never re-run).
      tester.view.viewInsets = const FakeViewPadding(bottom: 260);
      addTearDown(tester.view.resetViewInsets);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(tester.takeException(), isNull);
      expect(
        find.byType(FormProgressStrip),
        findsNothing,
        reason: 'chrome sheds the strip while the keyboard crowds the screen',
      );
      expect(find.text(_kNext), findsOneWidget, reason: 'the action stays');

      tester.view.resetViewInsets();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      expect(
        find.byType(FormProgressStrip),
        findsOneWidget,
        reason: 'the strip comes straight back when the keyboard closes',
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('D13 tablet — the option column stops at the kit form width', (
    WidgetTester tester,
  ) async {
    await pumpForm(tester, size: const Size(768, 1024), scale: 1.0);

    expect(
      widthOf(
        tester,
        find
            .ancestor(of: find.text('Hindi'), matching: find.byType(Material))
            .first,
      ),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
  });

  testWidgets('D6 tap targets — every control clears 48dp at 360x640', (
    WidgetTester tester,
  ) async {
    await pumpForm(tester, size: const Size(360, 640), scale: 1.0);

    // The option cards and the docked next button on page one…
    await expectKitTapTargets(tester);
    // …and the typing page's remove button, chips and year pickers.
    for (int i = 0; i < FinishingPage.values.length - 1; i++) {
      await advance(tester);
    }
    await tester.ensureVisible(find.text(_kAddEmployer));
    await tester.tap(find.text(_kAddEmployer));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    await expectKitTapTargets(tester);
  });

  testWidgets(
    'R17 / D8 — the work-history card names State (Rajya) before Sheher '
    '(City), and its focus ring is navy',
    (WidgetTester tester) async {
      await pumpForm(tester, size: const Size(390, 844), scale: 1.0);
      for (int i = 0; i < FinishingPage.values.length - 1; i++) {
        await advance(tester);
      }
      await tester.ensureVisible(find.text(_kAddEmployer));
      await tester.tap(find.text(_kAddEmployer));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));

      // Ruling R17: both labels name the field in Hinglish AND English…
      expect(find.text('State (Rajya)'), findsOneWidget);
      expect(find.text('Sheher (City)'), findsOneWidget);
      // …and the strict guideline puts State before Sheher on screen.
      expect(
        tester.getTopLeft(find.text('State (Rajya)')).dx,
        lessThan(tester.getTopLeft(find.text('Sheher (City)')).dx),
      );
      // The hint inside each box stays the bare word.
      expect(find.text('State'), findsOneWidget);
      expect(find.text('Sheher'), findsOneWidget);

      // D8: focus is navy at 1.8; yellow now means SELECTED only.
      final BorderSide focused =
          (tester
                      .widget<TextField>(find.byType(TextField).first)
                      .decoration!
                      .focusedBorder!
                  as OutlineInputBorder)
              .borderSide;
      expect(focused.color, OnboardingColors.shiftBlue);
      expect(focused.width, 1.8);
    },
  );

  testWidgets('a year chip is set in mono, per spec §1.2 (numbers in mono)', (
    WidgetTester tester,
  ) async {
    await pumpForm(tester, size: const Size(390, 844), scale: 1.0);
    for (int i = 0; i < FinishingPage.values.length - 1; i++) {
      await advance(tester);
    }
    await tester.ensureVisible(find.text(_kAddEmployer));
    await tester.tap(find.text(_kAddEmployer));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    // Open the start-date picker: year chips first.
    await tester.ensureVisible(find.text('Nahi bataya').first);
    await tester.tap(find.text('Nahi bataya').first);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    final FinishingChip chip = tester.widget<FinishingChip>(
      find.byWidgetPredicate(
        (Widget w) => w is FinishingChip && w.label == '2026',
      ),
    );
    expect(chip.labelStyle?.fontFamily, OnboardingTypography.monoFamily);
  });

  testWidgets('D11 real data — no slug and no raw rupee figure is shown', (
    WidgetTester tester,
  ) async {
    await pumpForm(tester, size: const Size(390, 844), scale: 1.0);

    // Walk every page, checking each one as it renders.
    for (int page = 0; page < FinishingPage.values.length; page++) {
      for (final String slug in _kWireSlugs) {
        expect(
          find.textContaining(slug),
          findsNothing,
          reason:
              '$slug is a wire value, never worker-facing copy '
              '(page ${FinishingPage.values[page]})',
        );
      }
      if (page < FinishingPage.values.length - 1) await advance(tester);
    }
  });
}

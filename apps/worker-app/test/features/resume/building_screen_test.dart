import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_edit_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_repository.dart';
import 'package:badabhai_worker_app/features/resume/domain/resume_safe_fields.dart';
import 'package:badabhai_worker_app/features/resume/presentation/building_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';

import '../../support/kit_matrix.dart';

class _MockResumeRepository extends Mock implements ResumeRepository {}

class _MockResumeEditRepository extends Mock implements ResumeEditRepository {}

class _MockProfileRepository extends Mock implements ProfileRepository {}

/// "Resume ban raha hai…" (spec §3.22) — the one screen a worker watches
/// rather than uses.
///
/// It had no widget test at all. Three things must hold: it never overflows on
/// any device (its 4-row ticker plus a navy header is the tallest fixed block
/// in the flow), it never claims progress it does not have, and it offers NO
/// Feedback button — the worker is meant to watch one thing finish.
void main() {
  late _MockResumeRepository repo;
  late _MockResumeEditRepository editRepo;
  late _MockProfileRepository profileRepo;

  /// Registers the cubit the screen resolves. [generate] decides which of the
  /// three surfaces renders.
  void registerGraph(Future<String> Function() generate) {
    when(
      () => repo.generateResume(force: any(named: 'force')),
    ).thenAnswer((_) => generate());
    when(
      () => repo.loadResumeDocument(),
    ).thenAnswer((_) async => const ResumeDocumentSnapshot());
    when(() => editRepo.load()).thenAnswer(
      (_) async => const ResumeSafeFields(
        displayName: 'Test',
        showPhoto: true,
        nightShiftReady: false,
      ),
    );
    locator.registerFactory<ResumeCubit>(
      () => ResumeCubit(repo, editRepo, profileRepo),
    );
  }

  setUp(() async {
    await locator.reset();
    repo = _MockResumeRepository();
    editRepo = _MockResumeEditRepository();
    profileRepo = _MockProfileRepository();
    // The generation NEVER resolves by default, which is exactly the state
    // this screen exists to draw. It also means no `context.go` fires, so the
    // screen can be pumped without a router.
    registerGraph(() => Completer<String>().future);
  });

  tearDown(() => locator.reset());

  Widget screen() => const BuildingScreen();

  /// Pumps past the screen's minimum-display window.
  ///
  /// `initState` arms a 900ms `Future.delayed` (the anti-flash floor), and
  /// flutter_test FAILS any test that ends with a timer still pending — so
  /// every test here has to run the clock past it. Never `pumpAndSettle`: the
  /// pacing tween and the live step's spinner settle only when the screen
  /// navigates away, which in these tests it never does.
  Future<void> pumpPastFloor(WidgetTester tester) =>
      tester.pump(const Duration(milliseconds: 1000));

  // ---- 1. the matrix ------------------------------------------------------

  kitMatrixTest(
    'generation view — no overflow, the ticker present',
    screen,
    primary: () => find.text('Skills jud rahi hain'),
    arrange: pumpPastFloor,
  );

  testWidgets('320x568 @2.0 keeps all four steps reachable', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(320, 568));
    await tester.pumpWidget(kitTestApp(screen(), textScale: 2.0));
    await tester.pump();
    await pumpPastFloor(tester);

    expect(tester.takeException(), isNull);
    for (final String step in <String>[
      'Details check ho gaye',
      'Trade profile ban raha hai',
      'Skills jud rahi hain',
      'Final PDF card taiyaar karna',
    ]) {
      if (find.text(step).evaluate().isEmpty) {
        await tester.scrollUntilVisible(
          find.text(step),
          120,
          scrollable: find.byType(Scrollable).first,
        );
      }
      expect(find.text(step), findsOneWidget);
    }
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('768x1024 caps the progress card at 440 (R13)', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(screen()));
    await tester.pump();
    await pumpPastFloor(tester);

    expect(
      widthOf(tester, find.text('Skills jud rahi hain').first),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
    await tester.pumpWidget(const SizedBox.shrink());
  });

  // ---- 2. the spec's own drawing ------------------------------------------

  group('spec values', () {
    testWidgets('the whole screen sits on SHIFT BLUE (§3.22)', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();
      await pumpPastFloor(tester);

      // One navy field under the header, with the white card the only thing on
      // it — not the app canvas every other onboarding screen uses.
      final ColoredBox field = tester.widget<ColoredBox>(
        find.byType(ColoredBox).first,
      );
      expect(field.color, OnboardingColors.shiftBlue);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('the ticker says Done / live / Baaki, and never claims 100%', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();
      // Part-way through the paced window, and past the display floor.
      await tester.pump(const Duration(milliseconds: 1500));

      // A done step reads as a check the worker can see, a pending one as the
      // 'Baaki' tag — never a bare spinner for the whole screen.
      expect(find.byIcon(Icons.check_rounded), findsWidgets);
      expect(find.text('Baaki'), findsWidgets);

      // The bar is DETERMINATE and stops short of full: the screen must not
      // say "finished" while the server is still working.
      final LinearProgressIndicator bar = tester
          .widget<LinearProgressIndicator>(
            find.byType(LinearProgressIndicator),
          );
      expect(bar.value, isNotNull);
      expect(bar.value, lessThan(1.0));
      expect(bar.valueColor!.value, OnboardingColors.safetyYellow);

      // The step counter is real, and mono so it cannot jitter as it ticks.
      expect(find.textContaining('STEP '), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('the progress card is flat — fill + hairline, never a shadow', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();
      await pumpPastFloor(tester);

      final BoxDecoration card =
          tester
                  .widget<Container>(
                    find
                        .ancestor(
                          of: find.byType(LinearProgressIndicator),
                          matching: find.byType(Container),
                        )
                        .last,
                  )
                  .decoration!
              as BoxDecoration;
      expect(card.color, OnboardingColors.paperWhite);
      expect(card.boxShadow, anyOf(isNull, isEmpty));
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('there is NO Feedback action anywhere on it', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();
      await pumpPastFloor(tester);

      // §3.22 gives this screen no feedback button; the app-wide floating pill
      // hides on /building for the same reason (feedback_fab.dart).
      expect(find.text('Feedback'), findsNothing);
      expect(find.byIcon(Icons.chat_bubble_outline_rounded), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('nothing on screen is a raw id, slug or enum (D11)', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();
      await pumpPastFloor(tester);

      final RegExp token = RegExp(r'\b[a-z0-9]+_[a-z0-9_]+\b');
      for (final Text text in tester.widgetList<Text>(find.byType(Text))) {
        final String? data = text.data;
        if (data == null) continue;
        expect(
          token.hasMatch(data),
          isFalse,
          reason: 'raw token on screen: "$data"',
        );
      }
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });

  // ---- 3. the recovery surface -------------------------------------------

  group('a failed generation', () {
    setUp(() async {
      await locator.reset();
      repo = _MockResumeRepository();
      editRepo = _MockResumeEditRepository();
      profileRepo = _MockProfileRepository();
      registerGraph(() async => throw const NetworkFailure());
    });

    testWidgets('says so honestly and keeps the way out, on the canvas', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();
      await pumpPastFloor(tester);

      expect(find.text('Resume nahi ban paya.'), findsOneWidget);
      // Cause-agnostic, but never a false "check internet" — and never the
      // ticker, which would claim work that is not happening.
      expect(find.text('Thodi der baad dobara try karein.'), findsOneWidget);
      expect(find.text('Dobara koshish karein'), findsOneWidget);
      expect(find.text('Skills jud rahi hain'), findsNothing);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('fits 320x568 @2.0 with the retry reachable', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(kitTestApp(screen(), textScale: 2.0));
      await tester.pump();
      await pumpPastFloor(tester);

      expect(tester.takeException(), isNull);
      expect(find.text('Dobara koshish karein'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('fits a LANDSCAPE phone at 2.0 — the shape that breaks a '
        'centred panel', (WidgetTester tester) async {
      // 844x390 is wider than the 440 content cap and shorter than the copy:
      // the exact combination that overflowed the profile-preview panel,
      // because its height was measured at the full viewport width and then
      // laid out at 440. This view's centred block is a fixed-size disc, so it
      // is immune — pinned here so it stays that way.
      setKitSurface(tester, const Size(844, 390));
      await tester.pumpWidget(kitTestApp(screen(), textScale: 2.0));
      await tester.pump();
      await pumpPastFloor(tester);

      expect(tester.takeException(), isNull);
      expect(find.text('Dobara koshish karein'), findsOneWidget);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('retry re-runs the generation', (WidgetTester tester) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();
      await pumpPastFloor(tester);

      await tester.tap(find.text('Dobara koshish karein'));
      await tester.pump();
      await tester.pump();

      verify(() => repo.generateResume(force: any(named: 'force'))).called(2);
      await tester.pumpWidget(const SizedBox.shrink());
    });

    testWidgets('every control clears the touch floor at 360x640 @1.0', (
      WidgetTester tester,
    ) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      setKitSurface(tester, const Size(360, 640));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();
      await pumpPastFloor(tester);

      await expectKitTapTargets(tester);
      handle.dispose();
      await tester.pumpWidget(const SizedBox.shrink());
    });
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bottom_bar_inset.dart';
import 'package:badabhai_worker_app/features/profile/domain/profile_repository.dart';
import 'package:badabhai_worker_app/features/profile/presentation/cubit/profile_cubit.dart';
import 'package:badabhai_worker_app/features/profile/presentation/profile_preview_screen.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary.dart';
import 'package:badabhai_worker_app/features/profile_tab/domain/profile_summary_repository.dart';

import '../../support/kit_matrix.dart';

class _MockProfileRepository extends Mock implements ProfileRepository {}

class _MockSummaryRepository extends Mock implements ProfileSummaryRepository {}

/// The profile CONFIRM step (kit 04) on every device a worker owns, plus the
/// real-data rules the screen must not break.
///
/// `profile_preview_screen_test.dart` owns the behaviour (what is confirmed,
/// where a confirm routes, the #844 strength row, the #1071 bar inset). This
/// file owns the drawing.
void main() {
  /// A long, real-shaped summary — the one that actually crowds a 320dp phone.
  const ProfileSummary kLong = ProfileSummary(
    tradeLabel: 'CNC operator and VMC setter with programming experience',
    city: 'Pimpri-Chinchwad, Pune district',
    educationLevel: 'iti',
    educationField: 'Machinist and fitter, two year course',
    strengthSignals: 0,
  );

  void registerGraph({
    required Future<ProfileSummary> Function() summary,
    Future<String> Function()? extract,
  }) {
    final _MockProfileRepository repo = _MockProfileRepository();
    final _MockSummaryRepository summaryRepo = _MockSummaryRepository();
    when(() => repo.extractProfile()).thenAnswer(
      (_) => extract == null ? Future<String>.value('p1') : extract(),
    );
    when(() => summaryRepo.summary()).thenAnswer((_) => summary());
    locator.registerFactory<ProfileCubit>(
      () => ProfileCubit(repo, summaryRepo),
    );
  }

  setUp(() async {
    await locator.reset();
    registerGraph(summary: () async => kLong);
  });

  tearDown(() async {
    bottomBarInset.value = 0;
    await locator.reset();
  });

  /// Three pumps: extracting → extract resolves → summary resolves (ready).
  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump();
    await tester.pump();
  }

  Widget screen() => const ProfilePreviewScreen();

  kitMatrixTest(
    'confirm step — no overflow, the confirm CTA present',
    screen,
    primary: () => find.text('Haan, sahi hai'),
    arrange: settle,
  );

  testWidgets('768x1024 caps the confirm column at 440 (R13)', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(screen()));
    await settle(tester);

    // The fact cards and the docked bar share the form column.
    expect(
      widthOf(tester, find.widgetWithText(Material, 'TRADE').first),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
    expect(
      widthOf(tester, find.widgetWithText(ElevatedButton, 'Haan, sahi hai')),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
  });

  testWidgets('every control clears the touch floor at 360x640 @1.0', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    setKitSurface(tester, const Size(360, 640));
    await tester.pumpWidget(kitTestApp(screen()));
    await settle(tester);

    await expectKitTapTargets(tester);
    handle.dispose();
  });

  testWidgets('the failed view also survives 320x568 @2.0 and keeps both '
      'ways out', (WidgetTester tester) async {
    await locator.reset();
    registerGraph(
      summary: () async => kLong,
      extract: () async => throw const NetworkFailure(),
    );
    setKitSurface(tester, const Size(320, 568));
    await tester.pumpWidget(kitTestApp(screen(), textScale: 2.0));
    await settle(tester);
    await tester.pump(const Duration(milliseconds: 300));

    expect(tester.takeException(), isNull);
    expect(find.text('Try again'), findsOneWidget);
    await tester.scrollUntilVisible(
      find.text('Chat pe wapas jaayein'),
      120,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('Chat pe wapas jaayein'), findsOneWidget);
  });

  group('real data only (D11)', () {
    testWidgets('a real display label is shown EXACTLY as the server wrote '
        'it', (WidgetTester tester) async {
      await locator.reset();
      registerGraph(
        summary: () async =>
            const ProfileSummary(tradeLabel: 'Welder', strengthSignals: 0),
      );
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await settle(tester);

      expect(find.text('Welder'), findsOneWidget);
    });

    testWidgets('a token-shaped trade is HUMANISED, never shown raw', (
      WidgetTester tester,
    ) async {
      await locator.reset();
      registerGraph(
        summary: () async => const ProfileSummary(
          tradeLabel: 'cnc_turner_operator',
          strengthSignals: 0,
        ),
      );
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await settle(tester);

      expect(find.text('CNC Turner/Operator'), findsOneWidget);
      expect(find.text('cnc_turner_operator'), findsNothing);
    });

    testWidgets('an INTERNAL id is hidden behind the honest waiting line', (
      WidgetTester tester,
    ) async {
      // `role_welder` / `mskill_*` are platform ids, not trades. There is
      // nothing honest to show, so the row says the profile is still being
      // finalised rather than printing an id the worker cannot read.
      await locator.reset();
      registerGraph(
        summary: () async =>
            const ProfileSummary(tradeLabel: 'role_welder', strengthSignals: 0),
      );
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await settle(tester);

      expect(find.text('role_welder'), findsNothing);
      expect(find.text('Tayyar ho raha hai…'), findsOneWidget);
    });

    testWidgets('a raw education token never reaches the screen', (
      WidgetTester tester,
    ) async {
      await locator.reset();
      registerGraph(
        summary: () async => const ProfileSummary(
          tradeLabel: 'Welder',
          educationLevel: 'below_10',
          strengthSignals: 0,
        ),
      );
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await settle(tester);

      expect(find.text('below_10'), findsNothing);
      expect(find.text('10th se kam'), findsOneWidget);
    });

    testWidgets('a block with no data is HIDDEN, never a placeholder row', (
      WidgetTester tester,
    ) async {
      await locator.reset();
      registerGraph(
        summary: () async =>
            const ProfileSummary(tradeLabel: 'Welder', strengthSignals: 0),
      );
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await settle(tester);

      // No city and no education on the wire → no City / Education rows at all.
      expect(find.text('TRADE'), findsOneWidget);
      expect(find.text('CITY'), findsNothing);
      expect(find.text('EDUCATION'), findsNothing);
    });
  });
}

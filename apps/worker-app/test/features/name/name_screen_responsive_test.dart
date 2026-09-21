import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/onboarding_select_field.dart';
import 'package:badabhai_worker_app/features/name/domain/location_lookup.dart';
import 'package:badabhai_worker_app/features/name/domain/name_repository.dart';
import 'package:badabhai_worker_app/features/name/presentation/cubit/name_cubit.dart';
import 'package:badabhai_worker_app/features/name/presentation/name_screen.dart';

import '../../support/kit_matrix.dart';

class _MockNameRepository extends Mock implements NameRepository {}

class _MockLocationLookup extends Mock implements LocationLookup {}

/// Name & location (spec §3.6/§3.10) across every device a worker owns.
///
/// This screen is the widest form in the flow — two name fields, a GPS button,
/// a hint line, two picker fields and a docked bar with two actions — so it is
/// the one most likely to overflow at a large system font, and the one where
/// the keyboard is up for the whole visit.
void main() {
  setUp(() async {
    await locator.reset();
    registerFallbackValue('');
    final _MockNameRepository repo = _MockNameRepository();
    when(
      () => repo.submitName(
        any(),
        city: any(named: 'city'),
        state: any(named: 'state'),
      ),
    ).thenAnswer((_) async {});
    final _MockLocationLookup lookup = _MockLocationLookup();
    // GPS is NOT silently available, so the mid-form permission-grant offer
    // never fires — an unstubbed call would throw inside the lifecycle hook.
    when(() => lookup.isAvailable()).thenAnswer((_) async => false);
    locator.registerFactory<NameRepository>(() => repo);
    locator.registerFactory<NameCubit>(
      () => NameCubit(locator<NameRepository>()),
    );
    locator.registerLazySingleton<LocationLookup>(() => lookup);
  });

  tearDown(() => locator.reset());

  Widget screen() => const NameScreen();

  kitMatrixTest(
    'name screen — no overflow, Continue present',
    screen,
    primary: () => find.text('Continue'),
  );

  testWidgets('320x568 @2.0 with the keyboard up keeps both fields and the '
      'docked actions reachable', (WidgetTester tester) async {
    setKitSurface(tester, const Size(320, 568), keyboard: 260);
    await tester.pumpWidget(kitTestApp(screen(), textScale: 2.0));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(tester.takeException(), isNull);
    // The bar is docked outside the scroll, so the keyboard cannot bury it.
    expect(find.text('Continue'), findsOneWidget);
    expect(find.text('Feedback'), findsOneWidget);

    // Both name fields are reachable by scrolling the body.
    await tester.scrollUntilVisible(
      find.text('AAKHRI NAAM (LAST NAME)'),
      120,
      scrollable: find.byType(Scrollable).first,
    );
    expect(find.text('AAKHRI NAAM (LAST NAME)'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('768x1024 caps the form column at 440 (R13)', (
    WidgetTester tester,
  ) async {
    setKitSurface(tester, const Size(768, 1024));
    await tester.pumpWidget(kitTestApp(screen()));
    await tester.pump();

    expect(
      widthOf(tester, find.byType(OnboardingSelectField).first),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
    expect(
      widthOf(tester, find.byType(TextField).first),
      lessThanOrEqualTo(OnboardingLayout.maxContentWidth),
    );
  });

  testWidgets('every control clears the touch floor at 360x640 @1.0', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle handle = tester.ensureSemantics();
    setKitSurface(tester, const Size(360, 640));
    await tester.pumpWidget(kitTestApp(screen()));
    await tester.pump();

    await expectKitTapTargets(tester);
    handle.dispose();
  });

  group('spec values', () {
    testWidgets('the fields carry the spec labels, STATE before CITY', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();

      // R17 — bilingual labels, so a worker who reads only one of the two
      // vocabularies still knows which box is which.
      expect(find.text('PEHLA NAAM (FIRST NAME)'), findsOneWidget);
      expect(find.text('AAKHRI NAAM (LAST NAME)'), findsOneWidget);
      expect(find.text('SHEHER AUR STATE'), findsOneWidget);

      // A city list only means something inside a state, so the order is fixed
      // (spec strict guideline: "State before City").
      expect(
        tester.getTopLeft(find.text('STATE (RAJYA)')).dy,
        lessThan(tester.getTopLeft(find.text('SHEHER (CITY)')).dy),
      );
    });

    testWidgets('a focused name field rings NAVY at 1.8, never yellow (D8)', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();

      // The first field autofocuses, so the ring is live on mount.
      final InputDecoration decoration = tester
          .widget<TextField>(find.byType(TextField).first)
          .decoration!;
      final BorderSide focused = decoration.focusedBorder!.borderSide;
      expect(focused.color, OnboardingColors.shiftBlue);
      expect(focused.width, 1.8);
      // Yellow means SELECTED in v3 — an input is never selected.
      expect(focused.color, isNot(OnboardingColors.borderActive));
      expect(
        decoration.enabledBorder!.borderSide.color,
        OnboardingColors.borderDefault,
      );
    });

    testWidgets('the docked Feedback pill is the v3 pill (D9)', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(screen()));
      await tester.pump();

      // Same glyph, size and label the app-wide floating pill draws — the two
      // are one action and only ever appear one at a time.
      final Icon glyph = tester.widget<Icon>(
        find.byIcon(Icons.chat_bubble_outline_rounded),
      );
      expect(glyph.size, 16);
      expect(glyph.color, OnboardingColors.textOnBlue);

      final TextStyle label = tester.widget<Text>(find.text('Feedback')).style!;
      expect(label.fontFamily, OnboardingTypography.bodyFamily);
      expect(label.fontSize, 13);
      expect(label.fontWeight, FontWeight.w700);
    });
  });
}

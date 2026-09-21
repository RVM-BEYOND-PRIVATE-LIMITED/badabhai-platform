import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:badabhai_worker_app/app.dart';

void main() {
  // The splash is the brand artwork (logo, wordmark, tagline) with the Flutter
  // "Get started" button on top.
  testWidgets('Splash shows brand and get-started CTA', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(const BadaBhaiApp());
    expect(find.byKey(const Key('splash_image')), findsOneWidget);
    expect(find.text('Get started'), findsOneWidget);
  });

  // UI kit v3, ruling R1: the app RESPECTS the phone's font-size setting
  // instead of hard-locking it to 1.0x, and clamps it to the range every
  // screen is verified against. Chrome re-clamps itself at 1.3x; body copy
  // scales the whole way to 2.0x.
  group('system font size (R1)', () {
    TextScaler scalerInApp(WidgetTester tester) => MediaQuery.textScalerOf(
      tester.element(find.byKey(const Key('splash_image'))),
    );

    testWidgets('a huge OS font is capped at 2.0x, not ignored', (
      WidgetTester tester,
    ) async {
      tester.platformDispatcher.textScaleFactorTestValue = 3.0;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

      await tester.pumpWidget(const BadaBhaiApp());

      expect(scalerInApp(tester).scale(10), 20);
    });

    testWidgets('an OS font SMALLER than the design size is floored at 1.0x', (
      WidgetTester tester,
    ) async {
      tester.platformDispatcher.textScaleFactorTestValue = 0.5;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

      await tester.pumpWidget(const BadaBhaiApp());

      expect(scalerInApp(tester).scale(10), 10);
    });

    testWidgets('a scale inside the range is passed through untouched', (
      WidgetTester tester,
    ) async {
      tester.platformDispatcher.textScaleFactorTestValue = 1.5;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

      await tester.pumpWidget(const BadaBhaiApp());

      expect(scalerInApp(tester).scale(10), 15);
    });
  });
}

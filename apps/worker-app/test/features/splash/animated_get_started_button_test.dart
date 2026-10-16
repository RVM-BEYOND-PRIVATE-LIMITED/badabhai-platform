import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/splash/presentation/widgets/animated_get_started_button.dart';

/// The splash CTA, animated (CEO ask): it rises in and its label rolls through
/// the languages of India — English first, then back to English.
void main() {
  Widget host({VoidCallback? onPressed, bool still = false}) => MaterialApp(
    home: MediaQuery(
      data: MediaQueryData(disableAnimations: still),
      child: Scaffold(
        body: Center(
          child: AnimatedGetStartedButton(onPressed: onPressed ?? () {}),
        ),
      ),
    ),
  );

  testWidgets('English first, then every language in turn, then English again', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(host());
    Duration now = Duration.zero;
    // Advance the fake clock to the swap at [at] (from the first frame), let
    // the roll-in run, and check that [label] alone is on the button.
    Future<void> expectAt(Duration at, String label) async {
      await tester.pump(at - now);
      await tester.pump(const Duration(milliseconds: 600));
      await tester.pump(); // the frame that drops the rolled-out label
      now = at + const Duration(milliseconds: 600);
      expect(find.text(label), findsOneWidget, reason: label);
      expect(find.byType(Text), findsOneWidget, reason: 'only $label');
    }

    await expectAt(Duration.zero, 'Get started');
    Duration swap = kGetStartedEnglishHold;
    for (int i = 1; i < kGetStartedLabels.length; i++) {
      await expectAt(swap, kGetStartedLabels[i]);
      swap += kGetStartedLanguageHold;
    }
    await expectAt(swap, 'Get started');
  });

  testWidgets('it covers Marathi, Telugu and the rest of India', (
    WidgetTester tester,
  ) async {
    expect(kGetStartedLabels.first, 'Get started');
    expect(kGetStartedLabels, contains('सुरू करा')); // Marathi
    expect(kGetStartedLabels, contains('ప్రారంభించండి')); // Telugu
    expect(kGetStartedLabels.length, greaterThanOrEqualTo(12));
    expect(kGetStartedLabels.toSet().length, kGetStartedLabels.length);
  });

  testWidgets('a tap works mid-roll, in any language', (
    WidgetTester tester,
  ) async {
    int taps = 0;
    await tester.pumpWidget(host(onPressed: () => taps++));
    await tester.pump(kGetStartedEnglishHold + const Duration(milliseconds: 200));
    await tester.tap(find.byType(ElevatedButton));
    expect(taps, 1);
  });

  testWidgets('TalkBack always hears "Get started", never the moving label', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle semantics = tester.ensureSemantics();
    await tester.pumpWidget(host());
    await tester.pump(kGetStartedEnglishHold);
    await tester.pumpAndSettle();
    expect(find.text(kGetStartedLabels[1]), findsOneWidget);
    expect(find.bySemanticsLabel('Get started'), findsOneWidget);
    expect(find.bySemanticsLabel(kGetStartedLabels[1]), findsNothing);
    semantics.dispose();
  });

  testWidgets('"remove animations" on: plain English button, no roll', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(host(still: true));
    await tester.pump(kGetStartedEnglishHold * 3);
    await tester.pumpAndSettle();
    expect(find.text('Get started'), findsOneWidget);
    expect(find.text(kGetStartedLabels[1]), findsNothing);
  });

  testWidgets('every language fits a narrow phone without overflow', (
    WidgetTester tester,
  ) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(host());
    for (int i = 0; i < kGetStartedLabels.length; i++) {
      await tester.pump(
        i == 0 ? kGetStartedEnglishHold : kGetStartedLanguageHold,
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: kGetStartedLabels[i]);
    }
  });
}

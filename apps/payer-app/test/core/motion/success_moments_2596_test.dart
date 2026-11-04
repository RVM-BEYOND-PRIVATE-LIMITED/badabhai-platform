import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/theme/app_motion.dart';
import 'package:payer_app/core/widgets/bb_rise_in.dart';
import 'package:payer_app/core/widgets/bb_stamp_celebration.dart';

/// #2596 (M8) — the success-moment tokens and the celebration's timing.
void main() {
  late List<String> haptics;

  setUp(() {
    haptics = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform,
            (MethodCall call) async {
      if (call.method == 'HapticFeedback.vibrate') {
        haptics.add(call.arguments as String);
      }
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  Widget host(Widget child, {bool reduced = false}) => MaterialApp(
        builder: (BuildContext context, Widget? app) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
          child: app!,
        ),
        home: Scaffold(body: child),
      );

  test('tokens match the issue', () {
    expect(AppMotion.stampLand, const Duration(milliseconds: 520));
    expect(AppMotion.countUp, const Duration(milliseconds: 600));
    expect(AppMotion.highlightFade, const Duration(milliseconds: 1500));
    expect(AppMotion.copiedHold, const Duration(milliseconds: 1200));
    expect(AppMotion.bubbleRise, const Duration(milliseconds: 180));
    expect(AppMotion.riseOffset, lessThanOrEqualTo(6));
    // The celebration = the land + a hold + the exit fade.
    expect(
      BbStampCelebration.lifetime,
      AppMotion.stampLand + AppMotion.slow + AppMotion.base,
    );
  });

  double fadeOf(WidgetTester tester) => tester
      .widget<FadeTransition>(find
          .descendant(
            of: find.byType(BbStampCelebration),
            matching: find.byType(FadeTransition),
          )
          .first)
      .opacity
      .value;

  testWidgets('the celebration lands, holds, then fades out (ease-in), once',
      (WidgetTester tester) async {
    await tester.pumpWidget(host(const BbStampCelebration(haptic: true)));
    expect(haptics, <String>['HapticFeedbackType.mediumImpact']);
    expect(fadeOf(tester), 1);

    await tester.pump(AppMotion.stampLand + AppMotion.slow);
    expect(fadeOf(tester), 1, reason: 'held through the land and the hold');

    await tester.pump(AppMotion.base);
    expect(fadeOf(tester), 0);
    await tester.pump(const Duration(seconds: 1));
    expect(haptics, hasLength(1));
    expect(tester.hasRunningAnimations, isFalse);
  });

  testWidgets('no haptic unless asked (the invite mint keeps its quiet stamp)',
      (WidgetTester tester) async {
    await tester.pumpWidget(host(const BbStampCelebration()));
    await tester.pumpAndSettle();
    expect(haptics, isEmpty);
  });

  testWidgets(
      'reduced motion: shown at full strength for the same time, then '
      'gone without a fade', (WidgetTester tester) async {
    await tester.pumpWidget(
      host(const BbStampCelebration(haptic: true), reduced: true),
    );
    expect(fadeOf(tester), 1);
    await tester.pump(const Duration(milliseconds: 1000));
    expect(fadeOf(tester), 1);
    await tester.pump(const Duration(milliseconds: 60));
    expect(fadeOf(tester), 0);
    // The confirmation haptic is not motion: it still fires.
    expect(haptics, hasLength(1));
  });

  testWidgets(
      'announcement: a live region while the stamp shows, gone once it '
      'faded; silent unless asked', (WidgetTester tester) async {
    final SemanticsHandle semantics = tester.ensureSemantics();
    await tester.pumpWidget(
      host(const BbStampCelebration(announcement: 'Candidate unlocked')),
    );
    expect(
      tester.getSemantics(find.bySemanticsLabel('Candidate unlocked')),
      containsSemantics(label: 'Candidate unlocked', isLiveRegion: true),
    );
    expect(find.semantics.byLabel('Candidate unlocked'), findsOneWidget);
    // Faded out: no longer in the semantics tree (nothing left to read).
    await tester.pumpAndSettle();
    expect(find.semantics.byLabel('Candidate unlocked'), findsNothing);

    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pumpWidget(host(const BbStampCelebration()));
    expect(find.semantics.byLabel('Candidate unlocked'), findsNothing);
    await tester.pumpAndSettle();
    semantics.dispose();
  });

  testWidgets('BbRiseIn: no controller, no motion when not animating',
      (WidgetTester tester) async {
    await tester.pumpWidget(host(const BbRiseIn(
      animate: false,
      child: Text('old'),
    )));
    expect(find.byType(FadeTransition), findsNothing);
    expect(tester.hasRunningAnimations, isFalse);
  });
}

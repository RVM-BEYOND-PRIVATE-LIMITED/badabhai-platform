// #1322 — the Profile-strength consumer, in isolation. Locks the three rules the
// spec (§9.1/§9.2) hangs on: three bands over strength/strength_max, AT MOST one
// humanized nudge (largest missing weight at Weak, one highest-value item at
// Fair, silence at Strong), the number NEVER shown as a grade, and no affordance
// that could gate the résumé download.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/core/theme/app_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_button.dart';
import 'package:badabhai_worker_app/features/profile_tab/presentation/widgets/profile_strength_card.dart';

Future<void> _pump(
  WidgetTester tester, {
  required int signals,
  int? max,
  required List<String> missingFields,
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(
        body: ProfileStrengthCard(
          signals: signals,
          max: max,
          missingFields: missingFields,
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  group('profileStrengthBand — three bands over strength/strength_max', () {
    test('at the contract max of 9: <=3 Weak, 4..6 Fair, >=7 Strong', () {
      for (int n = 0; n <= 3; n++) {
        expect(profileStrengthBand(signals: n, max: 9), ProfileStrengthBand.weak,
            reason: '$n of 9 should be Weak');
      }
      for (int n = 4; n <= 6; n++) {
        expect(profileStrengthBand(signals: n, max: 9), ProfileStrengthBand.fair,
            reason: '$n of 9 should be Fair');
      }
      for (int n = 7; n <= 12; n++) {
        expect(
            profileStrengthBand(signals: n, max: 9), ProfileStrengthBand.strong,
            reason: '$n of 9 should be Strong (count may exceed max)');
      }
    });

    test('a null/absent denominator falls back to the contract max (9)', () {
      expect(profileStrengthBand(signals: 3), ProfileStrengthBand.weak);
      expect(profileStrengthBand(signals: 4), ProfileStrengthBand.fair);
      expect(profileStrengthBand(signals: 7), ProfileStrengthBand.strong);
      expect(profileStrengthBand(signals: 5, max: 0), ProfileStrengthBand.fair);
    });

    test('boundaries scale proportionally to a different max (WA-4 seam)', () {
      // max 12 → weakCeil round(4)=4, fairCeil round(8)=8.
      expect(profileStrengthBand(signals: 4, max: 12), ProfileStrengthBand.weak);
      expect(profileStrengthBand(signals: 5, max: 12), ProfileStrengthBand.fair);
      expect(profileStrengthBand(signals: 8, max: 12), ProfileStrengthBand.fair);
      expect(
          profileStrengthBand(signals: 9, max: 12), ProfileStrengthBand.strong);
    });
  });

  group('the nudge — at most one, humanized', () {
    testWidgets('Weak surfaces the LARGEST missing weight (missing_fields.first)',
        (WidgetTester tester) async {
      await _pump(
        tester,
        signals: 1,
        max: 9,
        missingFields: <String>['salary', 'skills', 'photo'],
      );

      expect(find.text(kProfileStrengthWeakTitle), findsOneWidget);
      expect(find.text('Sabse zaroori: salary ki ummeed jodein.'),
          findsOneWidget);
      // The other missing slots are never shown — exactly one nudge.
      expect(find.textContaining('apni skills'), findsNothing);
      expect(find.textContaining('apni photo'), findsNothing);
    });

    testWidgets('Fair surfaces the SINGLE highest-value item (also .first)',
        (WidgetTester tester) async {
      await _pump(
        tester,
        signals: 6,
        max: 9,
        missingFields: <String>['photo', 'salary'],
      );

      expect(find.text(kProfileStrengthFairTitle), findsOneWidget);
      expect(find.text('Ek aur cheez: apni photo jodein.'), findsOneWidget);
      expect(find.textContaining('salary ki ummeed'), findsNothing);
    });

    testWidgets('Strong renders NOTHING (zero-height, no nudge)',
        (WidgetTester tester) async {
      await _pump(
        tester,
        signals: 9,
        max: 9,
        missingFields: <String>['photo'],
      );

      expect(find.text(kProfileStrengthWeakTitle), findsNothing);
      expect(find.text(kProfileStrengthFairTitle), findsNothing);
      expect(find.textContaining('jodein'), findsNothing);
      // The subtree collapses — the card takes up no space.
      final Size size = tester.getSize(find.byType(ProfileStrengthCard));
      expect(size.height, 0);
    });

    testWidgets('an empty missing_fields list shows no nudge, even below Strong',
        (WidgetTester tester) async {
      await _pump(tester, signals: 2, max: 9, missingFields: const <String>[]);
      expect(find.textContaining('jodein'), findsNothing);
      final Size size = tester.getSize(find.byType(ProfileStrengthCard));
      expect(size.height, 0);
    });
  });

  group('§9.2 — never a grade, never a gate', () {
    testWidgets('the raw number is never rendered as a score or an "N/9"',
        (WidgetTester tester) async {
      await _pump(
        tester,
        signals: 2,
        max: 9,
        missingFields: <String>['skills'],
      );

      // The nudge is shown, but it carries no digits, no fraction, no percent.
      expect(find.text('Sabse zaroori: apni skills jodein.'), findsOneWidget);
      expect(find.textContaining('2'), findsNothing);
      expect(find.textContaining('9'), findsNothing);
      expect(find.textContaining('/'), findsNothing);
      expect(find.textContaining('%'), findsNothing);
    });

    testWidgets('it is informational only — no button/tap that could gate download',
        (WidgetTester tester) async {
      await _pump(
        tester,
        signals: 0,
        max: 9,
        missingFields: <String>['role'],
      );

      // Even the weakest profile gets an informational nudge, never a blocker:
      // the widget exposes no button and no tap surface, so it cannot gate the
      // résumé download (which lives on the resume flow, unconditioned on this).
      expect(find.byType(BbButton), findsNothing);
      expect(find.byType(ElevatedButton), findsNothing);
      expect(find.byType(TextButton), findsNothing);
      expect(find.byType(InkWell), findsNothing);
      expect(find.byType(GestureDetector), findsNothing);
    });
  });
}

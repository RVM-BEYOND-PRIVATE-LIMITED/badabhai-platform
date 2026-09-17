import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/widgets/bada_bhai_mark.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/brand_badge.dart';

import '../../../support/kit_matrix.dart';

void main() {
  group('BrandBadge — the global no-pill lockup', () {
    testWidgets('draws the two-figure mark and no pill, border or wash', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(const Scaffold(body: Center(child: BrandBadge()))),
      );

      // The global vector mark (one white man + one yellow man), never the old
      // Material `people_alt` glyph.
      expect(find.byType(BadaBhaiMark), findsOneWidget);

      // NO PILL: the owner removed the border and the 12%-white background
      // permanently, so there is no decorated Container left in the lockup.
      expect(
        find.descendant(
          of: find.byType(BrandBadge),
          matching: find.byType(Container),
        ),
        findsNothing,
      );
    });

    testWidgets('spells the wordmark as one word, two capitals', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(const Scaffold(body: Center(child: BrandBadge()))),
      );

      expect(find.text('BadaBhai'), findsOneWidget);
      // The old ALL-CAPS wordmark is gone for good.
      expect(find.text('BADABHAI'), findsNothing);
    });
  });
}

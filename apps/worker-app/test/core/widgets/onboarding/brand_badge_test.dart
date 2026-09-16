import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/brand_badge.dart';

import '../../../support/kit_matrix.dart';

void main() {
  group('BrandBadge — spec §2.1', () {
    testWidgets('is a 16-radius pill padded 10/4 with a 13dp glyph', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(const Scaffold(body: Center(child: BrandBadge()))),
      );

      final Container pill = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(BrandBadge),
              matching: find.byType(Container),
            )
            .first,
      );
      expect(
        pill.padding,
        const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      );

      final BoxDecoration decoration = pill.decoration! as BoxDecoration;
      expect(
        decoration.borderRadius,
        BorderRadius.circular(OnboardingRadii.brandBadge),
      );

      final Icon glyph = tester.widget<Icon>(
        find.byIcon(Icons.people_alt_rounded),
      );
      expect(glyph.size, 13);
      expect(glyph.color, OnboardingColors.safetyYellow);
    });

    testWidgets('spells the wordmark as one word, two capitals', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(const Scaffold(body: Center(child: BrandBadge()))),
      );
      expect(find.text('BADABHAI'), findsOneWidget);
    });
  });
}

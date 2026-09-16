import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/brand_badge.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/shift_blue_header.dart';

import '../../../support/kit_matrix.dart';

Widget _header({
  String? subtitle,
  String? stepBadge,
  VoidCallback? onBack,
  List<Widget> actions = const <Widget>[],
  bool compact = false,
}) {
  return Scaffold(
    body: ShiftBlueHeader(
      title: 'Aapka naam?',
      subtitle: subtitle,
      stepBadge: stepBadge,
      onBack: onBack,
      actions: actions,
      compact: compact,
    ),
  );
}

void main() {
  group('ShiftBlueHeader — spec §2.1', () {
    testWidgets('pads 16 on the sides and 18 at the bottom', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(_header()));

      final Container band = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(ShiftBlueHeader),
              matching: find.byType(Container),
            )
            .first,
      );
      final EdgeInsets insets = band.padding! as EdgeInsets;
      expect(insets.left, 16);
      expect(insets.right, 16);
      expect(insets.bottom, 18);
      expect((band.color), OnboardingColors.shiftBlue);
    });

    testWidgets('the back glyph is 22 and sits ON the 16dp gutter, in a 48dp '
        'tap target', (WidgetTester tester) async {
      // A phone surface on purpose: on a canvas wider than the 440 content cap
      // the inner column centres, so the gutter is no longer at x=16.
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(kitTestApp(_header(onBack: () {})));

      final Finder arrow = find.byIcon(Icons.arrow_back_rounded);
      expect(tester.widget<Icon>(arrow).size, 22);
      // Aligned to the gutter, not centred in its box: the arrow lines up with
      // the title beneath it.
      expect(tester.getTopLeft(arrow).dx, 16);
      expect(
        tester.getSize(find.byType(IconButton)).width,
        OnboardingLayout.tapTarget,
      );
      expect(
        tester.getSize(find.byType(IconButton)).height,
        OnboardingLayout.tapTarget,
      );
      expect(find.byTooltip('Wapas'), findsOneWidget);
    });

    testWidgets('the subtitle sits 4 under the title', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(_header(subtitle: 'Yeh resume par')));

      final double titleBottom = tester
          .getBottomLeft(find.text('Aapka naam?'))
          .dy;
      final double subtitleTop = tester
          .getTopLeft(find.text('Yeh resume par'))
          .dy;
      expect(subtitleTop - titleBottom, closeTo(4, 0.01));
    });

    testWidgets('an uppercased step badge renders above the title', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(_header(stepBadge: 'Step 2 of 6')));
      expect(find.text('STEP 2 OF 6'), findsOneWidget);
    });

    testWidgets('actions supersede the brand badge', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(_header()));
      expect(find.byType(BrandBadge), findsOneWidget);

      await tester.pumpWidget(
        kitTestApp(
          _header(actions: <Widget>[const Icon(Icons.download_rounded)]),
        ),
      );
      expect(find.byType(BrandBadge), findsNothing);
      expect(find.byIcon(Icons.download_rounded), findsOneWidget);
    });

    testWidgets(
      'compact drops the badge row and holds the subtitle to a line',
      (WidgetTester tester) async {
        await tester.pumpWidget(
          kitTestApp(
            _header(subtitle: 'Yeh resume par', onBack: () {}, compact: true),
          ),
        );

        expect(find.byType(BrandBadge), findsNothing);
        expect(tester.widget<Text>(find.text('Yeh resume par')).maxLines, 1);
        // Back and title now share one row.
        expect(
          tester.getCenter(find.byIcon(Icons.arrow_back_rounded)).dy,
          closeTo(tester.getCenter(find.text('Aapka naam?')).dy, 12),
        );
      },
    );

    testWidgets(
      'AUTO-compacts once the keyboard leaves under 480dp of height',
      (WidgetTester tester) async {
        // The case this exists for: a 320x568 handset with the keyboard up. The
        // full header plus the keyboard left the actual form a sliver.
        setKitSurface(tester, const Size(320, 568), keyboard: 260);
        await tester.pumpWidget(
          kitTestApp(_header(subtitle: 'Yeh resume par', onBack: () {})),
        );
        await tester.pump();

        expect(tester.takeException(), isNull);
        expect(
          find.byType(BrandBadge),
          findsNothing,
          reason:
              'the badge row is the first thing to go when the keyboard '
              'has taken the screen',
        );
      },
    );

    testWidgets('keeps the full drawing when there is room, keyboard or not', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844), keyboard: 260);
      await tester.pumpWidget(kitTestApp(_header(onBack: () {})));
      await tester.pump();

      expect(find.byType(BrandBadge), findsOneWidget);
    });

    testWidgets('autoCompact: false pins the full drawing', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(320, 568), keyboard: 260);
      await tester.pumpWidget(
        kitTestApp(
          const Scaffold(
            body: ShiftBlueHeader(title: 'Aapka naam?', autoCompact: false),
          ),
        ),
      );
      await tester.pump();

      expect(find.byType(BrandBadge), findsOneWidget);
    });
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_nav.dart';

import '../support/kit_matrix.dart';

/// D13 for the shell's own chrome: the 4-tab bar is on screen on EVERY screen
/// of the app, so a bar that overflows at 320x568 or swallows the body at 2.0
/// breaks the whole app rather than one page.
///
/// The bar is pumped in the slot the shell gives it
/// (`Scaffold.bottomNavigationBar`) with a real body beside it, so a bar that
/// inflated to the screen height would be caught here as a zero-height body.
Widget _shellChrome({int currentIndex = 0}) => Scaffold(
  body: const SizedBox.expand(key: Key('shellBody')),
  bottomNavigationBar: BbBottomNav(currentIndex: currentIndex, onTap: (_) {}),
);

const List<String> _kLabels = <String>[
  'Jobs',
  'Resume',
  'Bada Bhai',
  'Profile',
];

void main() {
  group('shell chrome across the device matrix', () {
    for (final Size size in kKitMatrixSizes) {
      for (final double scale in kKitMatrixTextScales) {
        testWidgets(
          'the 4-tab bar holds at ${size.width.toInt()}x${size.height.toInt()} '
          '@ ${scale}x',
          (WidgetTester tester) async {
            setKitSurface(tester, size);
            await tester.pumpWidget(
              kitTestApp(_shellChrome(), textScale: scale),
            );
            await tester.pump();

            expect(
              tester.takeException(),
              isNull,
              reason: 'the bar overflowed at $size, text x$scale',
            );
            for (final String label in _kLabels) {
              expect(
                find.text(label),
                findsOneWidget,
                reason: '$label went missing at $size, text x$scale',
              );
            }
            // The chrome clamp is what keeps this a constant: the label grows
            // to 1.3 and stops, so the bar never eats the body.
            expect(
              tester.getSize(find.byType(BbBottomNav)).height,
              BbBottomNav.barHeight,
              reason: 'the bar must stay 64 at text x$scale',
            );
            expect(
              tester.getSize(find.byKey(const Key('shellBody'))).height,
              size.height - BbBottomNav.barHeight,
              reason: 'the body must keep every dp the bar does not use',
            );
          },
        );
      }
    }

    testWidgets('a keyboard over the smallest screen at 2.0 does not break the '
        'bar', (WidgetTester tester) async {
      // The shell itself has no text field, but a tab body does (chat, search),
      // and the bar rides above the keyboard while that field is focused.
      setKitSurface(tester, const Size(320, 568), keyboard: 260);
      await tester.pumpWidget(kitTestApp(_shellChrome(), textScale: 2.0));
      await tester.pump();

      expect(tester.takeException(), isNull);
      for (final String label in _kLabels) {
        expect(find.text(label), findsOneWidget);
      }
      expect(
        tester.getSize(find.byType(BbBottomNav)).height,
        BbBottomNav.barHeight,
      );
    });

    testWidgets('the items stop at 600 on a tablet', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(768, 1024));
      await tester.pumpWidget(kitTestApp(_shellChrome()));

      final Finder row = find
          .descendant(of: find.byType(BbBottomNav), matching: find.byType(Row))
          .first;
      expect(
        widthOf(tester, row),
        lessThanOrEqualTo(OnboardingLayout.maxTabContentWidth),
      );
    });

    testWidgets('every tab clears the Android tap-target guideline', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(360, 640));
      await tester.pumpWidget(kitTestApp(_shellChrome()));

      await expectKitTapTargets(tester);
    });
  });
}

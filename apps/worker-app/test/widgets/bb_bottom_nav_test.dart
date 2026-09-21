import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_nav.dart';

import '../support/kit_matrix.dart';

/// The bar in the slot the shell actually gives it
/// (`Scaffold.bottomNavigationBar`), because that is where its safe-area
/// padding and its fixed height have to hold — a bar measured in the middle of
/// a body proves nothing about the shell.
Widget _host(Widget bar) =>
    Scaffold(body: const SizedBox.expand(), bottomNavigationBar: bar);

const List<String> _kLabels = <String>[
  'Jobs',
  'Resume',
  'Bada Bhai',
  'Profile',
];

/// The 28x3 markers, in tab order.
Finder _markers() => find.byWidgetPredicate(
  (Widget w) =>
      w is Container &&
      w.constraints?.maxWidth == BbBottomNav.markerWidth &&
      w.constraints?.maxHeight == BbBottomNav.markerHeight,
);

Color? _markerColor(WidgetTester tester, int index) {
  final Container marker = tester
      .widgetList<Container>(_markers())
      .elementAt(index);
  return (marker.decoration! as BoxDecoration).color;
}

void main() {
  group('BbBottomNav', () {
    testWidgets('renders the four kit destination labels in order', (
      tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(_host(BbBottomNav(currentIndex: 0, onTap: (_) {}))),
      );

      expect(find.text('Jobs'), findsOneWidget);
      expect(find.text('Resume'), findsOneWidget);
      expect(find.text('Bada Bhai'), findsOneWidget);
      expect(find.text('Profile'), findsOneWidget);
      // Alerts is no longer a tab — it moved to a header bell (BbAlertsAction).
      expect(find.text('Alerts'), findsNothing);
    });

    testWidgets('tapping Bada Bhai fires onTap with index 2', (tester) async {
      int? tapped;
      await tester.pumpWidget(
        kitTestApp(
          _host(BbBottomNav(currentIndex: 0, onTap: (i) => tapped = i)),
        ),
      );

      await tester.tap(find.text('Bada Bhai'));
      expect(tapped, 2);
    });

    testWidgets('tapping Profile fires onTap with index 3', (tester) async {
      int? tapped;
      await tester.pumpWidget(
        kitTestApp(
          _host(BbBottomNav(currentIndex: 0, onTap: (i) => tapped = i)),
        ),
      );

      await tester.tap(find.text('Profile'));
      expect(tapped, 3);
    });

    testWidgets('the bar is 64 tall ABOVE the bottom safe-area inset, which it '
        'pads for itself (spec §2.3)', (WidgetTester tester) async {
      setKitSurface(tester, const Size(390, 844));
      // A gesture-bar phone. The bar has to pad this itself — the old
      // SafeArea did it, and a fixed 64 that ignored it would put the labels
      // under the system bar.
      tester.view.padding = const FakeViewPadding(bottom: 34);
      addTearDown(tester.view.resetPadding);

      await tester.pumpWidget(
        kitTestApp(_host(BbBottomNav(currentIndex: 0, onTap: (_) {}))),
      );

      expect(
        tester.getSize(find.byType(BbBottomNav)).height,
        BbBottomNav.barHeight + 34,
      );
      // The white surface is painted BEHIND the inset, so the canvas never
      // shows through beside the gesture bar.
      final Container surface = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(BbBottomNav),
              matching: find.byType(Container),
            )
            .first,
      );
      final BoxDecoration decoration = surface.decoration! as BoxDecoration;
      expect(decoration.color, OnboardingColors.paperWhite);
      expect(decoration.border!.top.color, OnboardingColors.borderDefault);
      expect(decoration.border!.top.width, 1);
      // D10 — the bar separates by hairline, never by shadow.
      expect(decoration.boxShadow, isNull);
    });

    testWidgets('the 28x3 marker is safety yellow on the ACTIVE tab and '
        'transparent on the other three', (WidgetTester tester) async {
      await tester.pumpWidget(
        kitTestApp(_host(BbBottomNav(currentIndex: 1, onTap: (_) {}))),
      );

      expect(_markers(), findsNWidgets(4));
      expect(
        tester.getSize(_markers().first),
        const Size(BbBottomNav.markerWidth, BbBottomNav.markerHeight),
      );
      expect(_markerColor(tester, 1), OnboardingColors.safetyYellow);
      for (final int inactive in <int>[0, 2, 3]) {
        expect(
          _markerColor(tester, inactive),
          Colors.transparent,
          reason:
              'the marker must reserve its height in every state, so the '
              'row does not reflow on tap',
        );
      }
    });

    testWidgets('the glyphs are the v3 rounded set at 22', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(_host(BbBottomNav(currentIndex: 0, onTap: (_) {}))),
      );

      for (final IconData glyph in <IconData>[
        Icons.work_outline_rounded,
        Icons.description_outlined,
        Icons.chat_bubble_outline_rounded,
        Icons.person_outline_rounded,
      ]) {
        expect(find.byIcon(glyph), findsOneWidget);
        expect(tester.widget<Icon>(find.byIcon(glyph)).size, 22);
      }
      expect(
        tester.widget<Icon>(find.byIcon(Icons.work_outline_rounded)).color,
        OnboardingColors.shiftBlue,
      );
      expect(
        tester.widget<Icon>(find.byIcon(Icons.person_outline_rounded)).color,
        OnboardingColors.ink500,
      );
    });

    testWidgets('the label is Inter 11 — w700 shift blue selected, w500 ink500 '
        'otherwise', (WidgetTester tester) async {
      await tester.pumpWidget(
        kitTestApp(_host(BbBottomNav(currentIndex: 2, onTap: (_) {}))),
      );

      final TextStyle selected = tester
          .widget<Text>(find.text('Bada Bhai'))
          .style!;
      expect(selected.fontFamily, OnboardingTypography.bodyFamily);
      expect(selected.fontSize, 11);
      expect(selected.fontWeight, FontWeight.w700);
      expect(selected.color, OnboardingColors.shiftBlue);

      final TextStyle idle = tester.widget<Text>(find.text('Jobs')).style!;
      expect(idle.fontFamily, OnboardingTypography.bodyFamily);
      expect(idle.fontSize, 11);
      expect(idle.fontWeight, FontWeight.w500);
      expect(idle.color, OnboardingColors.ink500);
    });

    testWidgets('a screen reader hears one button per tab, and which one is '
        'selected', (WidgetTester tester) async {
      // Disposed in-body, NOT through addTearDown: the framework's
      // "was every SemanticsHandle disposed" check runs BEFORE tearDowns, so a
      // handle parked there fails the test it was meant to serve.
      final SemanticsHandle handle = tester.ensureSemantics();

      await tester.pumpWidget(
        kitTestApp(_host(BbBottomNav(currentIndex: 1, onTap: (_) {}))),
      );

      // `bySemanticsLabel` reads the real semantics node, so finding these at
      // all is the proof that the label reaches a screen reader.
      expect(
        tester.getSemantics(find.bySemanticsLabel('Resume')),
        containsSemantics(label: 'Resume', isButton: true, isSelected: true),
      );
      expect(
        tester.getSemantics(find.bySemanticsLabel('Jobs')),
        containsSemantics(
          label: 'Jobs',
          isButton: true,
          // Only the visible tab is selected.
          isSelected: false,
        ),
      );

      handle.dispose();
    });

    testWidgets('every tab is a FULL-HEIGHT hit area, well past 48dp, even on '
        'a 320 screen', (WidgetTester tester) async {
      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(
        kitTestApp(_host(BbBottomNav(currentIndex: 0, onTap: (_) {}))),
      );

      // The whole bar minus its 1dp hairline, which the decoration insets the
      // items by — the band a thumb can actually land on.
      const double bandHeight = BbBottomNav.barHeight - 1;
      for (final String label in _kLabels) {
        final Size size = tester.getSize(
          find.ancestor(of: find.text(label), matching: find.byType(InkWell)),
        );
        expect(
          size.height,
          bandHeight,
          reason:
              '$label must be tappable over the whole bar, not just its '
              'glyph column',
        );
        expect(size.width, greaterThanOrEqualTo(OnboardingLayout.tapTarget));
      }
    });

    testWidgets('on a tablet the items stop at 600 and centre, while the white '
        'surface stays full-bleed', (WidgetTester tester) async {
      setKitSurface(tester, const Size(768, 1024));
      await tester.pumpWidget(
        kitTestApp(_host(BbBottomNav(currentIndex: 0, onTap: (_) {}))),
      );

      expect(widthOf(tester, find.byType(BbBottomNav)), 768);
      final Finder row = find
          .descendant(of: find.byType(BbBottomNav), matching: find.byType(Row))
          .first;
      expect(
        widthOf(tester, row),
        lessThanOrEqualTo(OnboardingLayout.maxTabContentWidth),
      );
      // Centred, not left-hugging: the first tab starts well inside the glass.
      expect(
        tester
            .getTopLeft(
              find.ancestor(
                of: find.text('Jobs'),
                matching: find.byType(InkWell),
              ),
            )
            .dx,
        greaterThan(0),
      );
    });
  });
}

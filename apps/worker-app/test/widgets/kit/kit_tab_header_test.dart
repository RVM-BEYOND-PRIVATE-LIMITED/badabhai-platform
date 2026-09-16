import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_header_actions.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_status_banner.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_tab_header.dart';

import '../../support/kit_matrix.dart';

void main() {
  group('KitTabHeader — spec §4', () {
    testWidgets('the title row is 48 tall on the navy band', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(const Scaffold(body: KitTabHeader(title: 'Your resume'))),
      );

      expect(KitTabHeader.rowHeight, 48);
      expect(find.text('Your resume'), findsOneWidget);
      final Container band = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(KitTabHeader),
              matching: find.byType(Container),
            )
            .first,
      );
      expect(band.color, OnboardingColors.shiftBlue);
    });

    testWidgets(
      "the last glyph's painted edge lands 16dp from the screen edge",
      (WidgetTester tester) async {
        // The band pads 3 on the right, not 16: each action is a 48dp hit box
        // around a 22dp glyph, so 3 + (48-22)/2 = 16 puts the INK where the
        // artboard puts it while the tap area stays legal.
        setKitSurface(tester, const Size(390, 844));
        await tester.pumpWidget(
          kitTestApp(
            Scaffold(
              body: KitTabHeader(
                title: 'Your resume',
                actions: <Widget>[
                  KitHeaderIconAction(
                    icon: Icons.notifications_outlined,
                    tooltip: 'Alerts',
                    onPressed: () {},
                  ),
                ],
              ),
            ),
          ),
        );

        final Finder bell = find.byIcon(Icons.notifications_outlined);
        expect(390 - tester.getBottomRight(bell).dx, closeTo(16, 0.5));
      },
    );

    testWidgets('three actions fit a 320 screen at 2.0 without overflowing', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(
        kitTestApp(
          Scaffold(
            body: KitTabHeader(
              title: 'Kaam milega.',
              actions: <Widget>[
                KitHeaderIconAction(
                  icon: Icons.search_rounded,
                  tooltip: 'Filter jobs',
                  onPressed: () {},
                ),
                KitHeaderIconAction(
                  icon: Icons.notifications_outlined,
                  tooltip: 'Alerts',
                  onPressed: () {},
                ),
                const KitFeedbackAction(),
              ],
            ),
          ),
          textScale: 2.0,
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
      // The title gives way, the actions do not: a header whose actions wrapped
      // would push the whole band down the screen.
      expect(find.byType(KitHeaderIconAction), findsNWidgets(2));
    });

    testWidgets('a long title takes a SECOND line rather than ellipsising to '
        'three characters', (WidgetTester tester) async {
      await tester.pumpWidget(
        kitTestApp(
          const Scaffold(
            body: KitTabHeader(
              title: 'A resume title long enough to run off any handset screen',
            ),
          ),
        ),
      );

      final Text title = tester.widget<Text>(find.byType(Text));
      expect(title.maxLines, 2);
      expect(title.overflow, TextOverflow.ellipsis);
    });

    testWidgets('the Feedback glyph is the YELLOW chat bubble, labelled '
        'Feedback', (WidgetTester tester) async {
      await tester.pumpWidget(
        kitTestApp(
          const Scaffold(
            body: KitTabHeader(
              title: 'Your resume',
              actions: <Widget>[KitFeedbackAction()],
            ),
          ),
        ),
      );

      expect(find.byTooltip('Feedback'), findsOneWidget);
      expect(
        tester
            .widget<Icon>(find.byIcon(Icons.chat_bubble_outline_rounded))
            .color,
        OnboardingColors.safetyYellow,
      );
    });
  });

  group('KitStatusBanner — spec §4', () {
    testWidgets('renders the title, an optional pill, a subline and a mark', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          const Scaffold(
            body: KitStatusBanner(
              title: 'Resume taiyaar',
              pillLabel: 'READY',
              subline: 'Bilkul free · share-ready',
              trailing: KitStatusCheck(),
            ),
          ),
        ),
      );

      expect(find.text('Resume taiyaar'), findsOneWidget);
      expect(find.text('READY'), findsOneWidget);
      expect(find.text('Bilkul free · share-ready'), findsOneWidget);
      expect(find.byType(KitStatusCheck), findsOneWidget);
    });

    testWidgets('hides the pill and the subline when there is no such data', (
      WidgetTester tester,
    ) async {
      // A worker whose PDF is still rendering must not be shown a READY badge
      // that is not true yet.
      await tester.pumpWidget(
        kitTestApp(
          const Scaffold(
            body: KitStatusBanner(title: 'PDF taiyaar ho rahi hai'),
          ),
        ),
      );

      expect(find.text('READY'), findsNothing);
      expect(find.byType(KitStatusCheck), findsNothing);
      expect(tester.takeException(), isNull);
    });

    testWidgets('the title row wraps instead of squeezing at 2.0', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(
        kitTestApp(
          const Scaffold(
            body: KitStatusBanner(
              title: 'Resume taiyaar',
              pillLabel: 'READY',
              subline: 'Bilkul free · share-ready',
            ),
          ),
          textScale: 2.0,
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
      expect(find.text('READY'), findsOneWidget);
    });
  });

  group('KitTabHeader — the 320dp floor', () {
    // The REAL faces: the whole point of this group is what the worker sees
    // painted, and the default test font measures nothing like Anek.
    setUpAll(loadKitFonts);

    testWidgets('the title is NOT truncated at 320 @2.0 with three actions, '
        'and the last action sits on the content column edge', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(
        kitTestApp(
          const Scaffold(
            body: KitTabHeader(
              title: 'Kaam milega.',
              actions: <Widget>[
                KitHeaderIconAction(
                  icon: Icons.search_rounded,
                  tooltip: 'Search',
                  onPressed: null,
                ),
                KitHeaderIconAction(
                  icon: Icons.notifications_outlined,
                  tooltip: 'Alerts',
                  onPressed: null,
                ),
                KitHeaderIconAction(
                  icon: Icons.chat_bubble_outline_rounded,
                  tooltip: 'Feedback',
                  size: 20,
                  onPressed: null,
                ),
              ],
            ),
          ),
          textScale: 2.0,
        ),
      );
      await tester.pump();

      // The whole title is PAINTED, not ellipsised to 'Kaa…'. The suite could
      // not see this before: the Text widget holds the full string either way,
      // so the assertion has to be on the rendered paragraph.
      final RenderParagraph title = tester.renderObject<RenderParagraph>(
        find.text('Kaam milega.'),
      );
      expect(
        title.didExceedMaxLines,
        isFalse,
        reason: 'the tab title truncated at the 320dp floor',
      );
      // And the actions end ON the right gutter (no Spacer stealing the space).
      expect(
        tester.getTopRight(find.byTooltip('Feedback')).dx,
        closeTo(320 - 3, 1),
      );
    });
  });
}

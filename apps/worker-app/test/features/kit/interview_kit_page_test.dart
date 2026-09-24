// The redesigned interview-kit widgets (drawn from interview_kit.png): the
// header's real controls, the search field, the kit card and the tip.
//
// These are RENDER-level contracts — the screen-level behaviour (filtering,
// TTS, dictation, states) is pinned in kit_responsive_test.dart.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/kit/presentation/widgets/interview_kit_widgets.dart';

import '../../support/kit_matrix.dart';

Widget _host(Widget child, {double width = 390}) => Scaffold(
  backgroundColor: Colors.white,
  body: SizedBox(width: width, child: child),
);

void main() {
  group('InterviewKitHeader', () {
    testWidgets('the back control fires through its 48dp tap area', (
      WidgetTester tester,
    ) async {
      int backs = 0;
      await tester.pumpWidget(
        kitTestApp(
          _host(InterviewKitHeader(onBack: () => backs++)),
        ),
      );

      // Regression: the Audio pill's transparent tap area once stretched across
      // the whole row and swallowed this tap.
      await tester.tap(find.byTooltip('Wapas'));
      await tester.pump();
      expect(backs, 1);
      expect(
        tester.getSize(find.byTooltip('Wapas')).height,
        greaterThanOrEqualTo(48),
      );
    });

    testWidgets('the design title is on the navy chrome', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(_host(InterviewKitHeader(onBack: () {}))),
      );

      expect(find.text(InterviewKitHeader.title), findsOneWidget);
    });
  });

  group('InterviewKitSearchField', () {
    testWidgets('reports typing and clears through the caller', (
      WidgetTester tester,
    ) async {
      final TextEditingController controller = TextEditingController();
      addTearDown(controller.dispose);
      final List<String> typed = <String>[];
      int clears = 0;

      Widget field() => kitTestApp(
        _host(
          InterviewKitSearchField(
            controller: controller,
            onChanged: typed.add,
            onClear: () => clears++,
          ),
        ),
      );

      await tester.pumpWidget(field());

      expect(find.text(InterviewKitSearchField.hint), findsOneWidget);
      await tester.enterText(find.byKey(const Key('kitSearchField')), 'vmc');
      await tester.pump();
      expect(typed, <String>['vmc']);

      // The caller rebuilds on onChanged; that rebuild is what surfaces the
      // clear control (there is text to clear now).
      await tester.pumpWidget(field());
      await tester.tap(find.byTooltip('Search saaf karein'));
      await tester.pump();
      expect(clears, 1);
    });

    testWidgets('paints no border in any state — the app theme must not leak', (
      WidgetTester tester,
    ) async {
      final TextEditingController controller = TextEditingController();
      addTearDown(controller.dispose);
      await tester.pumpWidget(
        kitTestApp(
          _host(
            InterviewKitSearchField(
              controller: controller,
              onChanged: (_) {},
              onClear: () {},
            ),
          ),
        ),
      );

      InputDecoration effective() => tester
          .widget<InputDecorator>(
            find.descendant(
              of: find.byKey(const Key('kitSearchField')),
              matching: find.byType(InputDecorator),
            ),
          )
          .decoration;

      // The app-wide InputDecorationTheme used to outline this field through
      // enabledBorder/focusedBorder, which `InputDecoration.collapsed` does not
      // clear — the visible "black border" around the inner text.
      final InputDecoration idle = effective();
      expect(<InputBorder?>[
        idle.border,
        idle.enabledBorder,
        idle.focusedBorder,
        idle.disabledBorder,
        idle.errorBorder,
        idle.focusedErrorBorder,
      ], everyElement(InputBorder.none));

      await tester.tap(find.byKey(const Key('kitSearchField')));
      await tester.pump();
      expect(effective().focusedBorder, InputBorder.none);
    });
  });

  group('InterviewKitCard', () {
    testWidgets('draws the REAL title/subtitle and opens on tap', (
      WidgetTester tester,
    ) async {
      String? opened;
      await tester.pumpWidget(
        kitTestApp(
          _host(
            InterviewKitCard(
              tradeKey: 'cnc_operator',
              title: 'CNC Operator',
              subtitle: 'Common sawaal · checklist · documents',
              onTap: () => opened = 'cnc_operator',
            ),
          ),
        ),
      );

      expect(find.text('CNC Operator'), findsOneWidget);
      expect(
        find.text('Common sawaal · checklist · documents'),
        findsOneWidget,
      );
      // The trade's derived tile — the CNC kit draws the wrench.
      expect(find.byIcon(Icons.build_outlined), findsOneWidget);
      expect(find.byIcon(Icons.chevron_right_rounded), findsOneWidget);

      await tester.tap(find.byType(InterviewKitCard));
      await tester.pump();
      expect(opened, 'cnc_operator');
    });

    testWidgets('an unknown trade key still gets an icon, never a blank tile', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(
            InterviewKitCard(
              tradeKey: 'space_welder_9000',
              title: 'Space Welder',
              subtitle: 'Common sawaal · checklist · documents',
              onTap: () {},
            ),
          ),
        ),
      );

      expect(find.text('Space Welder'), findsOneWidget);
      expect(find.byType(Icon), findsWidgets);
    });
  });

  group('InterviewKitTipCard', () {
    testWidgets('renders the design tip copy', (WidgetTester tester) async {
      await tester.pumpWidget(kitTestApp(_host(const InterviewKitTipCard())));

      expect(find.text(InterviewKitTipCard.title), findsOneWidget);
      expect(find.text(InterviewKitTipCard.body), findsOneWidget);
    });
  });
}

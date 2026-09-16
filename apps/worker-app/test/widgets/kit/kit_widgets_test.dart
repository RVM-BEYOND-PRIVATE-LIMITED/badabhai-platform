import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bottom_bar_inset.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_callout.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_card.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_check_row.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_docked_bar.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_info_chip.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_micro_label.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_pill.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_salary_box.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_select_chip.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_square_icon_button.dart';

import '../../support/kit_matrix.dart';

Widget _host(Widget child, {double width = 360}) => Scaffold(
  body: Center(
    child: SizedBox(width: width, child: child),
  ),
);

void main() {
  group('KitInfoChip', () {
    testWidgets('a 60-char label in a 320-wide Wrap at 2.0 does not overflow', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(
        kitTestApp(
          _host(
            const Wrap(
              children: <Widget>[
                KitInfoChip(
                  label:
                      'Horizontal machining centre with a 4th axis rotary '
                      'table',
                ),
              ],
            ),
            width: 300,
          ),
          textScale: 2.0,
        ),
      );
      await tester.pump();

      expect(tester.takeException(), isNull);
    });

    testWidgets('the check is HIDDEN by default — a tick claims verification '
        'nobody performed', (WidgetTester tester) async {
      await tester.pumpWidget(
        kitTestApp(_host(const KitInfoChip(label: 'VMC'))),
      );
      expect(find.byIcon(Icons.check_rounded), findsNothing);

      await tester.pumpWidget(
        kitTestApp(_host(const KitInfoChip(label: 'VMC', showCheck: true))),
      );
      expect(find.byIcon(Icons.check_rounded), findsOneWidget);
    });
  });

  group('KitSelectChip', () {
    testWidgets('selected is a navy fill, a yellow border and a yellow check', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(KitSelectChip(label: 'Turning', selected: true, onTap: () {})),
        ),
      );

      final Container box = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(KitSelectChip),
              matching: find.byType(Container),
            )
            .first,
      );
      final BoxDecoration decoration = box.decoration! as BoxDecoration;
      expect(decoration.color, OnboardingColors.shiftBlue);
      expect(decoration.border!.top.color, OnboardingColors.safetyYellow);
      expect(
        tester.widget<Icon>(find.byIcon(Icons.check_rounded)).color,
        OnboardingColors.safetyYellow,
      );
    });

    testWidgets('unselected is white behind a hairline, with no check', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(KitSelectChip(label: 'Turning', selected: false, onTap: () {})),
        ),
      );

      final Container box = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(KitSelectChip),
              matching: find.byType(Container),
            )
            .first,
      );
      final BoxDecoration decoration = box.decoration! as BoxDecoration;
      expect(decoration.color, OnboardingColors.paperWhite);
      expect(decoration.border!.top.color, OnboardingColors.borderDefault);
      expect(find.byIcon(Icons.check_rounded), findsNothing);
    });

    testWidgets(
      'clears the 48dp floor and reports selected to a screen reader',
      (WidgetTester tester) async {
        await tester.pumpWidget(
          kitTestApp(
            _host(
              KitSelectChip(label: 'Turning', selected: true, onTap: () {}),
            ),
          ),
        );

        expect(
          tester.getSize(find.byType(KitSelectChip)).height,
          greaterThanOrEqualTo(OnboardingLayout.tapTarget),
        );
        expect(
          tester.getSemantics(find.byType(KitSelectChip)),
          containsSemantics(isButton: true, isSelected: true),
        );
      },
    );

    testWidgets('SHRINK-WRAPS inside a Wrap — a chip, not a full-width row', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      await tester.pumpWidget(
        kitTestApp(
          Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(16),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: <Widget>[
                  for (final String label in <String>['CNC', 'VMC', 'Welder'])
                    KitSelectChip(
                      label: label,
                      selected: false,
                      onTap: () {},
                    ),
                ],
              ),
            ),
          ),
        ),
      );

      // 358 is the Wrap's full inner width. Every chip used to measure exactly
      // that (`Container.alignment` wraps the child in an `Align`, which fills
      // bounded constraints), so five short filter labels became five
      // full-width stacked rows and the sheet had to scroll for them.
      for (final Element chip in find.byType(KitSelectChip).evaluate()) {
        expect(
          (chip.renderObject! as RenderBox).size.width,
          lessThan(200),
          reason: 'a chip filled the Wrap instead of sizing to its label',
        );
      }
      // All three fit on ONE run.
      expect(
        tester.getTopLeft(find.byType(KitSelectChip).at(2)).dy,
        tester.getTopLeft(find.byType(KitSelectChip).first).dy,
      );
    });

    testWidgets('fires onTap', (WidgetTester tester) async {
      int taps = 0;
      await tester.pumpWidget(
        kitTestApp(
          _host(
            KitSelectChip(
              label: 'Turning',
              selected: false,
              onTap: () => taps++,
            ),
          ),
        ),
      );
      await tester.tap(find.byType(KitSelectChip));
      expect(taps, 1);
    });
  });

  group('KitSalaryBox', () {
    testWidgets('lays the label and figure side by side when there is room', (
      WidgetTester tester,
    ) async {
      // 440 is room for BOTH texts whole in the test font, which is the only
      // condition the box lays them out on one line for. (The old 360 here was
      // 5px short of fitting them and only passed because the figure used to
      // overflow the box instead of moving under the label.)
      await tester.pumpWidget(
        kitTestApp(
          _host(
            const KitSalaryBox(label: 'Salary', value: 'Rs 35,000 / month'),
            width: 440,
          ),
        ),
      );

      expect(find.byType(Row), findsWidgets);
      final double labelY = tester.getCenter(find.text('Salary')).dy;
      final double valueY = tester.getCenter(find.text('Rs 35,000 / month')).dy;
      expect(labelY, closeTo(valueY, 1));
      expect(tester.takeException(), isNull);
    });

    testWidgets('a real RANGE on a 412dp phone stacks instead of overflowing', (
      WidgetTester tester,
    ) async {
      // The résumé profile card hands the box about 320dp on a 412dp phone.
      // 'Expected Salary' + '₹24,000 – ₹28,000 / month' does not fit that on
      // one line, and the figure must not be the thing that gives way.
      setKitSurface(tester, const Size(412, 915));
      await tester.pumpWidget(
        kitTestApp(
          _host(
            const KitSalaryBox(
              label: 'Expected Salary',
              value: '₹24,000 – ₹28,000 / month',
            ),
            width: 320,
          ),
        ),
      );

      final double labelY = tester.getCenter(find.text('Expected Salary')).dy;
      final double valueY = tester
          .getCenter(find.text('₹24,000 – ₹28,000 / month'))
          .dy;
      expect(valueY, greaterThan(labelY));
      expect(tester.takeException(), isNull);
    });

    testWidgets('at text scale 2.0 it still refuses to overflow', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(
        kitTestApp(
          _host(
            const KitSalaryBox(
              label: 'Expected Salary',
              value: '₹24,000 – ₹28,000 / month',
            ),
            width: 300,
          ),
          textScale: 2.0,
        ),
      );

      expect(tester.takeException(), isNull);
    });

    testWidgets('STACKS below 300dp — the figure is the point of the box and '
        'must stay whole', (WidgetTester tester) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(
            const KitSalaryBox(label: 'Salary', value: 'Rs 35,000 / month'),
            width: 258,
          ),
        ),
      );

      final double labelY = tester.getCenter(find.text('Salary')).dy;
      final double valueY = tester.getCenter(find.text('Rs 35,000 / month')).dy;
      expect(valueY, greaterThan(labelY));
      expect(tester.takeException(), isNull);
    });

    testWidgets('the figure is tabular mono, so digits never jitter', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(const KitSalaryBox(label: 'Salary', value: 'Rs 35,000')),
        ),
      );

      final Text value = tester.widget<Text>(find.text('Rs 35,000'));
      expect(value.style!.fontFamily, 'Roboto Mono');
      expect(
        value.style!.fontFeatures,
        contains(const FontFeature.tabularFigures()),
      );
    });
  });

  group('KitCardHeader', () {
    testWidgets('shows a real count as digits ONLY (no "Verified")', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(
            const KitCard(
              child: KitCardHeader(
                icon: Icons.settings_suggest_rounded,
                title: 'Machines & CNC Controllers',
                count: 7,
              ),
            ),
          ),
        ),
      );

      expect(find.text('7'), findsOneWidget);
      // Capability rows are self-declared; there is no verification signal on
      // the wire, so the pill must not imply one.
      expect(find.textContaining('Verified'), findsNothing);
    });

    testWidgets('hides the pill at null and at 0 — never a placeholder count', (
      WidgetTester tester,
    ) async {
      for (final int? count in <int?>[null, 0]) {
        await tester.pumpWidget(
          kitTestApp(
            _host(
              KitCard(
                child: KitCardHeader(
                  icon: Icons.settings_suggest_rounded,
                  title: 'Machines',
                  count: count,
                ),
              ),
            ),
          ),
        );
        expect(
          find.byType(KitCountPill),
          findsNothing,
          reason: 'count: $count',
        );
      }
    });
  });

  group('KitSquareIconButton', () {
    testWidgets('paints 50x48, keeps a 48dp hit box, and excludes its caption '
        'from semantics', (WidgetTester tester) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(
            KitSquareIconButton(
              icon: Icons.volume_up_outlined,
              semanticLabel: 'Sawaal sunein',
              caption: 'SUNIE',
              onTap: () {},
            ),
          ),
        ),
      );

      // The FIRST SizedBox is the painted tile; the second is the 2dp gap
      // between the glyph and its caption.
      final Size tile = tester.getSize(
        find
            .descendant(
              of: find.byType(KitSquareIconButton),
              matching: find.byType(SizedBox),
            )
            .first,
      );
      expect(tile.width, 50);
      expect(tile.height, 48);

      final Size hit = tester.getSize(find.byType(KitSquareIconButton));
      expect(hit.width, greaterThanOrEqualTo(OnboardingLayout.tapTarget));
      expect(hit.height, greaterThanOrEqualTo(OnboardingLayout.tapTarget));

      expect(find.bySemanticsLabel('Sawaal sunein'), findsOneWidget);
      expect(find.bySemanticsLabel('SUNIE'), findsNothing);
    });

    testWidgets('a null onTap renders disabled rather than a dead control', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(
            const KitSquareIconButton(
              icon: Icons.volume_up_outlined,
              semanticLabel: 'Sawaal sunein',
            ),
          ),
        ),
      );

      expect(
        tester.widget<Icon>(find.byIcon(Icons.volume_up_outlined)).color,
        OnboardingColors.disabledText,
      );
    });
  });

  group('KitDockedBar', () {
    testWidgets('publishes its OWN height, and leaves the page its body', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      bottomBarInset.value = 0;
      addTearDown(() => bottomBarInset.value = 0);

      await tester.pumpWidget(
        kitTestApp(
          Scaffold(
            body: const SizedBox.expand(key: Key('pageBody')),
            bottomNavigationBar: KitDockedBar(
              child: FilledButton(onPressed: () {}, child: const Text('Save')),
            ),
          ),
        ),
      );
      await tester.pump();

      // `greaterThan(0)` is NOT the contract, and it passed the bug: in the
      // bottomNavigationBar slot (loose but FINITE height) the bar filled the
      // whole 844dp viewport, published 844, collapsed the body to zero height
      // and floated the Feedback pill clean off the bottom of the screen.
      final double barHeight = tester.getSize(find.byType(KitDockedBar)).height;
      expect(bottomBarInset.value, barHeight);
      expect(barHeight, lessThan(160));
      expect(
        tester.getSize(find.byKey(const Key('pageBody'))).height,
        greaterThan(0),
      );
    });
  });

  group('KitPill / KitMicroLabel / KitCheckRow / KitCallout', () {
    testWidgets('a yellow pill sits on the navy tint', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(const KitPill(label: 'READY', tone: KitPillTone.yellow)),
        ),
      );

      final Container pill = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(KitPill),
              matching: find.byType(Container),
            )
            .first,
      );
      expect(
        (pill.decoration! as BoxDecoration).color,
        OnboardingColors.yellowTint20,
      );
      expect(find.text('READY'), findsOneWidget);
    });

    testWidgets('the micro label uppercases at RENDER, so the source string '
        'stays readable', (WidgetTester tester) async {
      await tester.pumpWidget(
        kitTestApp(_host(const KitMicroLabel('Operated machines'))),
      );
      expect(find.text('OPERATED MACHINES'), findsOneWidget);
    });

    testWidgets('a check row states a fact with a green tick', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(_host(const KitCheckRow(label: 'Fanuc Series 0i'))),
      );
      expect(find.text('Fanuc Series 0i'), findsOneWidget);
      expect(
        tester.widget<Icon>(find.byIcon(Icons.check_rounded)).color,
        OnboardingColors.successGreen,
      );
    });

    testWidgets('a callout renders its tile, title and text', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(
          _host(
            const KitCallout(
              tileIcon: Icons.menu_book_rounded,
              title: 'Drawing reading',
              text: 'Reads 2D drawings',
            ),
          ),
        ),
      );

      expect(find.text('DRAWING READING'), findsOneWidget);
      expect(find.text('Reads 2D drawings'), findsOneWidget);
      expect(
        tester.widget<Icon>(find.byIcon(Icons.menu_book_rounded)).color,
        OnboardingColors.safetyYellow,
      );
    });
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/onboarding_theme.dart';
import 'package:badabhai_worker_app/core/widgets/bottom_bar_inset.dart';
import 'package:badabhai_worker_app/core/widgets/kit/kit_square_icon_button.dart';
import 'package:badabhai_worker_app/core/widgets/onboarding/questionnaire_bottom_bar.dart';

import '../../../support/kit_matrix.dart';

Widget _bar({
  VoidCallback? onNext,
  VoidCallback? onListen,
  bool isAudioSupported = true,
  Widget? leading,
  OnboardingVariant variant = OnboardingVariant.standard,
}) {
  return Scaffold(
    // An EXPANDED body, so a test can see whether the bar left the page any
    // room at all — a bar that ate the viewport collapsed this to zero.
    body: const SizedBox.expand(key: Key('pageBody')),
    bottomNavigationBar: QuestionnaireBottomBar(
      onNext: onNext ?? () {},
      onListen: onListen,
      isAudioSupported: isAudioSupported,
      leading: leading,
      variant: variant,
    ),
  );
}

void main() {
  group('QuestionnaireBottomBar — spec §2.2', () {
    testWidgets('pads 16/16/10 with the safe-area bottom plus 10', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(_bar()));

      final Container bar = tester.widget<Container>(
        find
            .descendant(
              of: find.byType(QuestionnaireBottomBar),
              matching: find.byType(Container),
            )
            .first,
      );
      final EdgeInsets insets = bar.padding! as EdgeInsets;
      expect(insets.left, 16);
      expect(insets.right, 16);
      expect(insets.top, 10);
      // No safe-area inset in the test view, so bottom is the bare 10.
      expect(insets.bottom, 10);
    });

    testWidgets('the next button is 48 tall', (WidgetTester tester) async {
      await tester.pumpWidget(kitTestApp(_bar()));

      expect(
        tester.getSize(find.byType(ElevatedButton)).height,
        OnboardingLayout.dockedButtonHeight,
      );
    });

    testWidgets('the listen tile is a 50x48 SUNIE button', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(_bar(onListen: () {})));

      expect(find.text('SUNIE'), findsOneWidget);
      expect(find.byIcon(Icons.volume_up_outlined), findsOneWidget);
      // The FIRST SizedBox is the painted tile; the second is the 2dp gap
      // between the glyph and its caption.
      final Size size = tester.getSize(
        find
            .descendant(
              of: find.byType(KitSquareIconButton),
              matching: find.byType(SizedBox),
            )
            .first,
      );
      expect(size.width, 50);
      expect(size.height, 48);
    });

    testWidgets('NO DEAD BUTTONS — no listen tile without a handler or audio', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(kitTestApp(_bar()));
      expect(find.text('SUNIE'), findsNothing);
      expect(find.byIcon(Icons.volume_up_outlined), findsNothing);

      await tester.pumpWidget(
        kitTestApp(_bar(onListen: () {}, isAudioSupported: false)),
      );
      expect(
        find.text('SUNIE'),
        findsNothing,
        reason:
            'a screen with no audio must not show a speaker that '
            'cannot speak',
      );
    });

    testWidgets('the caption is NOT what TalkBack reads', (
      WidgetTester tester,
    ) async {
      // 'SUNIE' is a four-letter cue for a worker who has never met an
      // icon-only speaker button. Read aloud it is noise, so the tile
      // announces the whole sentence instead and the caption is excluded.
      await tester.pumpWidget(kitTestApp(_bar(onListen: () {})));

      expect(find.bySemanticsLabel('Sawaal sunein'), findsOneWidget);
      expect(find.bySemanticsLabel('SUNIE'), findsNothing);
    });

    testWidgets('tapping the tile fires onListen', (WidgetTester tester) async {
      int listens = 0;
      await tester.pumpWidget(kitTestApp(_bar(onListen: () => listens++)));

      await tester.tap(find.byIcon(Icons.volume_up_outlined));
      expect(listens, 1);
    });

    testWidgets('leading replaces the listen tile entirely', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(_bar(onListen: () {}, leading: const Text('Feedback'))),
      );

      expect(find.text('Feedback'), findsOneWidget);
      expect(find.text('SUNIE'), findsNothing);
    });

    testWidgets('publishes its OWN height to bottomBarInset — with the listen '
        'tile shown — and leaves the page its body', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(390, 844));
      bottomBarInset.value = 0;
      addTearDown(() => bottomBarInset.value = 0);

      await tester.pumpWidget(kitTestApp(_bar(onListen: () {})));
      await tester.pump();

      // `greaterThan(0)` is NOT the contract, and it passed the bug: the SUNIE
      // tile's bare `Center` stretched the bar to the full 844dp viewport, so
      // the bar published 844, the body collapsed to zero height and the
      // Feedback pill floated off the bottom of the screen.
      final double barHeight = tester
          .getSize(find.byType(QuestionnaireBottomBar))
          .height;
      expect(bottomBarInset.value, barHeight);
      expect(barHeight, lessThan(160));
      expect(
        tester.getSize(find.byKey(const Key('pageBody'))).height,
        greaterThan(0),
      );
    });

    testWidgets('survives 320x568 at 2.0 text scale with the tile shown', (
      WidgetTester tester,
    ) async {
      setKitSurface(tester, const Size(320, 568));
      await tester.pumpWidget(
        kitTestApp(_bar(onListen: () {}), textScale: 2.0),
      );
      await tester.pump(const Duration(milliseconds: 300));

      expect(tester.takeException(), isNull);
      expect(find.text('SUNIE'), findsOneWidget);
      // Still a BAR: chrome clamps its own text scale, so 2.0 must not grow it
      // into a panel that leaves the question no room.
      expect(
        tester.getSize(find.byType(QuestionnaireBottomBar)).height,
        lessThan(160),
      );
      expect(
        tester.getSize(find.byKey(const Key('pageBody'))).height,
        greaterThan(0),
      );
    });

    testWidgets('the form-flow variant keeps its 52dp button and the caption', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        kitTestApp(_bar(onListen: () {}, variant: OnboardingVariant.formFlow)),
      );

      expect(
        tester.getSize(find.byType(ElevatedButton)).height,
        OnboardingLayout.buttonHeight,
      );
      expect(find.text('SUNIE'), findsOneWidget);
    });
  });
}

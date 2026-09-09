import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_colors.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_keypad.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_view.dart';

/// The [BoxDecoration] painted by the Nth [AnimatedContainer] slot.
BoxDecoration _slotDecoration(WidgetTester tester, int index) {
  final AnimatedContainer box =
      tester.widgetList<AnimatedContainer>(find.byType(AnimatedContainer)).elementAt(index);
  return box.decoration! as BoxDecoration;
}

void main() {
  group('BbPinKeypad', () {
    testWidgets('emits the tapped digit and backspace; no OS keyboard',
        (WidgetTester tester) async {
      final List<String> digits = <String>[];
      int backspaces = 0;
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: BbPinKeypad(
            onDigit: digits.add,
            onBackspace: () => backspaces++,
          ),
        ),
      ));

      await tester.tap(find.text('7'));
      await tester.tap(find.text('4'));
      await tester.tap(find.byIcon(Icons.backspace_outlined));

      expect(digits, <String>['7', '4']);
      expect(backspaces, 1);
      // Custom keypad — no TextField (no OS keyboard surface for the PIN).
      expect(find.byType(TextField), findsNothing);
    });

    // #375 — the digit keys are announced because they carry text; backspace is
    // a bare Icon in an InkResponse, so TalkBack read only "button". A worker
    // who mistyped could not find the key to fix it and drove into the lockout.
    testWidgets('the backspace key carries a spoken label',
        (WidgetTester tester) async {
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: BbPinKeypad(onDigit: (_) {}, onBackspace: () {}),
        ),
      ));

      expect(find.bySemanticsLabel(kBackspaceSemanticLabel), findsOneWidget);
      handle.dispose();
    });

    testWidgets('disabled keypad emits nothing', (WidgetTester tester) async {
      final List<String> digits = <String>[];
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: BbPinKeypad(
            enabled: false,
            onDigit: digits.add,
            onBackspace: () {},
          ),
        ),
      ));
      await tester.tap(find.text('5'));
      expect(digits, isEmpty);
    });
  });

  group('BbPinView (masked indicator)', () {
    testWidgets('renders only dot COUNT — never the digits', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 2)),
      ));
      // SECURITY: the entered PIN must never be rendered as text. No digit glyphs.
      for (final String d in <String>['0', '1', '2', '3', '4', '5']) {
        expect(find.text(d), findsNothing);
      }
      // Four box containers (length), regardless of how many are filled.
      expect(find.byType(AnimatedContainer), findsNWidgets(4));
    });

    testWidgets('renders rounded BOXES, not circles', (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 0)),
      ));
      final BoxDecoration deco = _slotDecoration(tester, 0);
      expect(deco.shape, BoxShape.rectangle);
      expect(deco.borderRadius, isNotNull);
    });

    testWidgets('empty slots have a GREY border; filled slots turn theme BLUE',
        (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 2)),
      ));

      expect(_slotDecoration(tester, 0).border!.top.color, AppColors.blue);
      expect(_slotDecoration(tester, 1).border!.top.color, AppColors.blue);
      expect(_slotDecoration(tester, 2).border!.top.color, AppColors.borderStrong);
      expect(_slotDecoration(tester, 3).border!.top.color, AppColors.borderStrong);
    });

    testWidgets('error tints a filled slot crimson, not blue',
        (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 1, error: true)),
      ));

      expect(_slotDecoration(tester, 0).border!.top.color, AppColors.danger);
    });

    testWidgets(
        'filled slots show a STAR tinted the border colour; empty slots show none',
        (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 2)),
      ));

      expect(find.byIcon(Icons.star_rounded), findsNWidgets(2));
      final Icon star =
          tester.widgetList<Icon>(find.byIcon(Icons.star_rounded)).first;
      expect(star.color, AppColors.blue);
    });

    testWidgets('an error tints the star crimson too', (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 1, error: true)),
      ));

      final Icon star =
          tester.widgetList<Icon>(find.byIcon(Icons.star_rounded)).first;
      expect(star.color, AppColors.danger);
    });
  });

  // #1463 — the set-PIN rows showed NO cursor at all: the capture field was a
  // 1x1 box under Opacity(0) with showCursor:false, and BbPinView only ever
  // knew a COUNT, so nothing on screen could say which slot (or which of the
  // two rows) the next digit would land in.
  group('BbPinView — the caret on the active slot', () {
    Finder caretFinder() => find.byKey(kPinCaretKey);

    double caretOpacity(WidgetTester tester) => tester
        .widget<FadeTransition>(find.ancestor(
          of: caretFinder(),
          matching: find.byType(FadeTransition),
        ))
        .opacity
        .value;

    testWidgets('unfocused renders NO caret — the unlock screen is untouched',
        (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 2)),
      ));

      expect(caretFinder(), findsNothing);
      // And the old grey/blue split still holds exactly as before.
      expect(_slotDecoration(tester, 2).border!.top.color,
          AppColors.borderStrong);
    });

    testWidgets('focused puts ONE caret in the next empty slot',
        (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 2, focused: true)),
      ));

      expect(caretFinder(), findsOneWidget);
      // Slot 2 is next, so it takes the live colour even though it is EMPTY —
      // that is the difference between "typed" and "typing here".
      expect(_slotDecoration(tester, 2).border!.top.color, AppColors.blue);
      expect(_slotDecoration(tester, 2).border!.top.width, 2.5);
      // Slot 3 is still an ordinary empty box.
      expect(_slotDecoration(tester, 3).border!.top.color,
          AppColors.borderStrong);
      expect(_slotDecoration(tester, 3).border!.top.width, 2);
    });

    testWidgets('on a FULL row the caret holds on the last slot, beside its star',
        (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 4, focused: true)),
      ));

      // Falling off the end would leave a worker who taps back into a finished
      // row with no idea where backspace bites.
      expect(caretFinder(), findsOneWidget);
      // The star is NEVER dropped to make room — the row would then under-report
      // how many digits are actually in.
      expect(find.byIcon(Icons.star_rounded), findsNWidgets(4));
    });

    // Regression: marking the active slot by making it FULL SIZE silently
    // killed the fill-pop. The active slot is the only one a digit ever lands
    // in, so if it is already at 1.0 the digit changes no scale at all — and
    // the pop is the one piece of feedback a worker who cannot see the digit
    // gets. The ring and the caret mark it instead; neither is a size.
    testWidgets('the active EMPTY slot stays small, so the fill-pop survives',
        (WidgetTester tester) async {
      BbPinView.debugDeterministicCaret = true;
      addTearDown(() => BbPinView.debugDeterministicCaret = false);

      double scaleAt(int i) => tester
          .widgetList<AnimatedScale>(find.byType(AnimatedScale))
          .elementAt(i)
          .scale;

      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 1, focused: true)),
      ));
      // Slot 1 is active and empty — small, with room to pop.
      expect(scaleAt(1), lessThan(1.0));
      expect(scaleAt(0), 1.0);

      // The digit lands there: THAT is the pop, and it must be a real change.
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 2, focused: true)),
      ));
      expect(scaleAt(1), 1.0);
    });

    testWidgets('the caret takes the error tint with the rest of the row',
        (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(
          body: BbPinView(length: 4, filled: 1, focused: true, error: true),
        ),
      ));

      final Container caret = tester.widget<Container>(caretFinder());
      expect((caret.decoration! as BoxDecoration).color, AppColors.danger);
    });

    testWidgets('SECURITY: a focused row still renders no digit glyph',
        (WidgetTester tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 3, focused: true)),
      ));

      for (final String d in <String>['0', '1', '2', '3', '4', '5']) {
        expect(find.text(d), findsNothing);
      }
    });

    // Deliberately NOT frozen here, and deliberately pumped in discrete steps —
    // this is the one test that proves the blink actually blinks. Every other
    // suite that reaches a focused row freezes it via debugDeterministicCaret,
    // because a perpetual blink makes pumpAndSettle time out.
    testWidgets('the caret really blinks, at Flutter\'s own half-period',
        (WidgetTester tester) async {
      expect(BbPinView.debugDeterministicCaret, isFalse,
          reason: 'this test needs the real blink');
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 0, focused: true)),
      ));

      // A HARD toggle, never a fade: driving the opacity linearly left a 2.5px
      // bar part-transparent for most of its life, which reads as a smudge.
      // On for the first 500ms half, off for the second — the Android caret's
      // own rhythm, and the rhythm the worker already knows.
      expect(caretOpacity(tester), 1.0);
      await tester.pump(const Duration(milliseconds: 250));
      expect(caretOpacity(tester), 1.0);
      await tester.pump(const Duration(milliseconds: 300)); // 550ms — past half
      expect(caretOpacity(tester), 0.0);
      await tester.pump(const Duration(milliseconds: 300)); // 850ms — still off
      expect(caretOpacity(tester), 0.0);
      await tester.pump(const Duration(milliseconds: 300)); // 1150ms — cycled
      expect(caretOpacity(tester), 1.0);
    });

    testWidgets('freezing the blink still PAINTS the caret, fully opaque',
        (WidgetTester tester) async {
      BbPinView.debugDeterministicCaret = true;
      addTearDown(() => BbPinView.debugDeterministicCaret = false);

      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 0, focused: true)),
      ));

      expect(caretFinder(), findsOneWidget);
      expect(caretOpacity(tester), 1.0);
      await tester.pump(const Duration(milliseconds: 600));
      expect(caretOpacity(tester), 1.0);
      // No frame left scheduled — this is what keeps pumpAndSettle finite.
      expect(tester.binding.hasScheduledFrame, isFalse);
    });

    testWidgets(
        'a FULL focused row fits a 320dp screen at textScale 2.0 — star AND caret',
        (WidgetTester tester) async {
      BbPinView.debugDeterministicCaret = true;
      addTearDown(() => BbPinView.debugDeterministicCaret = false);
      tester.view.physicalSize = const Size(320, 480);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      await tester.pumpWidget(const MaterialApp(
        home: MediaQuery(
          data: MediaQueryData(textScaler: TextScaler.linear(2.0)),
          child: Scaffold(
            body: Center(child: BbPinView(length: 4, filled: 4, focused: true)),
          ),
        ),
      ));

      // The worst case: every box filled AND focused, so one 56px box carries a
      // 20px star, a 4px gap and the caret on the narrowest handset we support.
      expect(tester.takeException(), isNull);
      // Wider than Flutter's own 2.0 default caret, so it is never a hairline.
      expect(tester.getSize(find.byKey(kPinCaretKey)).width, 2.5);
    });

    // Regression: the controller used to be a `late final` initialiser that the
    // frozen path never touched, so dispose() built it on a deactivated element
    // and createTicker's inherited TickerMode lookup threw.
    testWidgets('disposing a frozen caret throws nothing',
        (WidgetTester tester) async {
      BbPinView.debugDeterministicCaret = true;
      addTearDown(() => BbPinView.debugDeterministicCaret = false);

      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: BbPinView(length: 4, filled: 0, focused: true)),
      ));
      await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox())));

      expect(tester.takeException(), isNull);
    });
  });

}

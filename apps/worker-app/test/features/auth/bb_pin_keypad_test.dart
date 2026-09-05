import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/theme/app_colors.dart';
import 'package:badabhai_worker_app/features/auth/domain/weak_pin.dart';
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

  group('isWeakPin (hint heuristic — never a block)', () {
    test('flags repeated and sequential PINs', () {
      expect(isWeakPin('1111'), isTrue);
      expect(isWeakPin('0000'), isTrue);
      expect(isWeakPin('1234'), isTrue);
      expect(isWeakPin('4321'), isTrue);
    });

    test('passes a non-obvious PIN', () {
      expect(isWeakPin('7416'), isFalse);
      expect(isWeakPin('2580'), isFalse);
      expect(isWeakPin('9043'), isFalse);
    });
  });
}

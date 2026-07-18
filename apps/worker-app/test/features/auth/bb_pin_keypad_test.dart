import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/auth/domain/weak_pin.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_keypad.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_view.dart';

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
      // Four dot containers (length), regardless of how many are filled.
      expect(find.byType(AnimatedContainer), findsNWidgets(4));
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

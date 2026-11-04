import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/theme/app_colors.dart';
import 'package:payer_app/core/theme/app_motion.dart';
import 'package:payer_app/core/theme/app_theme.dart';
import 'package:payer_app/core/widgets/bb_otp_input.dart';

/// #2595 (M7) — the six-box one-time-code entry: one real (transparent) field
/// owns the input, the boxes draw it. Typing, a pasted full code, backspace,
/// the auto-submit callback, the per-digit pop and reduced motion.
void main() {
  final ThemeData theme = AppTheme.light();
  const Key field = Key('otp');

  late List<String> completed;
  late List<String> changed;

  setUp(() {
    completed = <String>[];
    changed = <String>[];
  });

  Future<void> pumpOtp(
    WidgetTester tester, {
    bool reduced = false,
    String? errorText,
  }) async {
    await tester.pumpWidget(MaterialApp(
      theme: theme,
      builder: (BuildContext context, Widget? app) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
        child: app!,
      ),
      home: Scaffold(
        body: Padding(
          padding: const EdgeInsets.all(16),
          child: BbOtpInput(
            fieldKey: field,
            onCompleted: completed.add,
            onChanged: changed.add,
            errorText: errorText,
          ),
        ),
      ),
    ));
  }

  String digitIn(WidgetTester tester, int box) => tester
      .widget<Text>(find.descendant(
        of: find.byKey(BbOtpInput.boxKey(box)),
        matching: find.byType(Text),
      ))
      .data!;

  List<String> digits(WidgetTester tester) => <String>[
        for (int i = 0; i < 6; i++) digitIn(tester, i),
      ];

  BorderSide edgeOf(WidgetTester tester, int box) {
    final BoxDecoration decoration = tester
        .widget<DecoratedBox>(find.descendant(
          of: find.byKey(BbOtpInput.boxKey(box)),
          matching: find.byType(DecoratedBox),
        ))
        .decoration as BoxDecoration;
    return (decoration.border! as Border).top;
  }

  Animation<double> popOf(WidgetTester tester, int box) => tester
      .widget<ScaleTransition>(find.byKey(BbOtpInput.boxKey(box)))
      .scale;

  double scaleOf(WidgetTester tester, int box) => popOf(tester, box).value;

  /// The box's own pop is idle (the field's focus edge animates on its own
  /// clock, so the global "running animations" flag would not prove this).
  bool popIdle(WidgetTester tester, int box) {
    final AnimationStatus status = popOf(tester, box).status;
    return status != AnimationStatus.forward &&
        status != AnimationStatus.reverse;
  }

  String text(WidgetTester tester) =>
      tester.widget<TextField>(find.byKey(field)).controller!.text;

  testWidgets('draws six boxes', (WidgetTester tester) async {
    await pumpOtp(tester);
    for (int i = 0; i < 6; i++) {
      expect(find.byKey(BbOtpInput.boxKey(i)), findsOneWidget);
    }
    expect(find.byKey(BbOtpInput.boxKey(6)), findsNothing);
    expect(digits(tester), <String>['', '', '', '', '', '']);
  });

  testWidgets('typing fills the boxes left to right', (
    WidgetTester tester,
  ) async {
    await pumpOtp(tester);
    await tester.enterText(find.byKey(field), '4');
    await tester.enterText(find.byKey(field), '42');
    await tester.enterText(find.byKey(field), '427');
    await tester.pump();
    expect(digits(tester), <String>['4', '2', '7', '', '', '']);
    expect(changed, <String>['4', '42', '427']);
    expect(completed, isEmpty);
  });

  testWidgets('onCompleted fires once, as the sixth digit lands', (
    WidgetTester tester,
  ) async {
    await pumpOtp(tester);
    await tester.enterText(find.byKey(field), '12345');
    expect(completed, isEmpty);
    await tester.enterText(find.byKey(field), '123456');
    expect(completed, <String>['123456']);
    // A no-op edit on a full code does not submit it again.
    await tester.enterText(find.byKey(field), '123456');
    expect(completed, <String>['123456']);
  });

  testWidgets('a pasted full code fills every box at once', (
    WidgetTester tester,
  ) async {
    await pumpOtp(tester);
    await tester.enterText(find.byKey(field), 'Your OTP is 482 916. Valid 10 min');
    await tester.pump();
    expect(digits(tester), <String>['4', '8', '2', '9', '1', '6']);
    expect(completed, <String>['482916']);
  });

  testWidgets('a pasted code replaces one already entered', (
    WidgetTester tester,
  ) async {
    await pumpOtp(tester);
    await tester.enterText(find.byKey(field), '111111');
    // The paste lands after the old code (the caret is always at the end).
    await tester.enterText(find.byKey(field), '111111654321');
    await tester.pump();
    expect(text(tester), '654321');
    expect(completed, <String>['111111', '654321']);
  });

  testWidgets('a seventh keystroke and non-digits never land', (
    WidgetTester tester,
  ) async {
    await pumpOtp(tester);
    await tester.enterText(find.byKey(field), '123456');
    await tester.enterText(find.byKey(field), '1234567');
    expect(text(tester), '123456');
    expect(completed, <String>['123456']);

    await tester.enterText(find.byKey(field), 'ab1-2c');
    expect(text(tester), '12');
  });

  testWidgets('backspace removes the last digit and steps the active box back',
      (WidgetTester tester) async {
    await pumpOtp(tester);
    await tester.tap(find.byKey(BbOtpInput.boxKey(0)));
    await tester.pump();
    await tester.enterText(find.byKey(field), '1234');
    await tester.pump();
    // The next box to fill (index 4) carries the blue focus edge.
    expect(edgeOf(tester, 4).color, AppColors.blue);
    expect(edgeOf(tester, 4).width, 2);
    expect(edgeOf(tester, 3).color, AppColors.borderStrong);

    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    await tester.pump();
    expect(text(tester), '123');
    expect(digits(tester), <String>['1', '2', '3', '', '', '']);
    expect(edgeOf(tester, 3).color, AppColors.blue);
    expect(edgeOf(tester, 4).color, AppColors.borderStrong);
  });

  testWidgets('re-entering a removed last digit submits again', (
    WidgetTester tester,
  ) async {
    await pumpOtp(tester);
    await tester.tap(find.byKey(BbOtpInput.boxKey(0)));
    await tester.pump();
    await tester.enterText(find.byKey(field), '123456');
    await tester.sendKeyEvent(LogicalKeyboardKey.backspace);
    await tester.pump();
    expect(text(tester), '12345');
    await tester.enterText(find.byKey(field), '123456');
    expect(completed, <String>['123456', '123456']);
  });

  testWidgets('each box pops to 1.04 over 90ms as its digit lands', (
    WidgetTester tester,
  ) async {
    await pumpOtp(tester);
    await tester.enterText(find.byKey(field), '7');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 45));
    expect(scaleOf(tester, 0), closeTo(AppMotion.popScale, 0.001));
    // Only the box that got a digit moves.
    expect(scaleOf(tester, 1), 1);

    await tester.pump(const Duration(milliseconds: 50));
    expect(scaleOf(tester, 0), 1);
    // One beat — it does not loop.
    expect(popIdle(tester, 0), isTrue);
  });

  testWidgets('no pop under reduced motion', (WidgetTester tester) async {
    await pumpOtp(tester, reduced: true);
    await tester.enterText(find.byKey(field), '7');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 45));
    expect(scaleOf(tester, 0), 1);
    expect(popIdle(tester, 0), isTrue);
  });

  testWidgets('an error shows under the boxes and edges them crimson', (
    WidgetTester tester,
  ) async {
    await pumpOtp(tester, errorText: 'That code is not right');
    expect(find.text('That code is not right'), findsOneWidget);
    expect(edgeOf(tester, 0).color, AppColors.danger);
  });

  testWidgets('tapping a box opens the keyboard on the code field', (
    WidgetTester tester,
  ) async {
    await pumpOtp(tester);
    final EditableText editable = tester.widget<EditableText>(
      find.descendant(of: find.byKey(field), matching: find.byType(EditableText)),
    );
    expect(editable.focusNode.hasFocus, isFalse);
    await tester.tap(find.byKey(BbOtpInput.boxKey(3)));
    await tester.pump();
    expect(editable.focusNode.hasFocus, isTrue);
    // The platform can surface the SMS code for it.
    expect(
      tester.widget<TextField>(find.byKey(field)).autofillHints,
      const <String>[AutofillHints.oneTimeCode],
    );
  });
}

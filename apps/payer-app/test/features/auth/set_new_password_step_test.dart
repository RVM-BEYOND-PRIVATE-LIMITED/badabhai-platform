import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/theme/app_motion.dart';
import 'package:payer_app/core/widgets/bb_field_error.dart';
import 'package:payer_app/features/auth/presentation/widgets/password_rules.dart';
import 'package:payer_app/features/auth/presentation/widgets/set_new_password_step.dart';

/// #2597 — the set-new-password step in isolation: the rules tick off with a
/// 160ms check morph, local refusals are inline and send nothing, the server's
/// reason shows inline, the keyboard walks Next → Done, and the step's slide is
/// 300ms of opacity + ≤6px transform that drops to zero under reduced motion —
/// all timed by the shared [AppMotion] tokens. Both fields are one OS autofill
/// context, committed only once the payer is signed in.
const String _kTemp = 'Temp9xQ2';

const Key _kNew = Key('new_password_field');
const Key _kConfirm = Key('new_password_confirm');
const Key _kSubmit = Key('new_password_submit');
const Key _kBack = Key('new_password_back');

/// Records what the step hands its caller.
class _Calls {
  final List<String> submitted = <String>[];
  int back = 0;
  int edited = 0;
  bool answer = false;
}

Widget _host(
  _Calls calls, {
  bool busy = false,
  String? serverError,
}) {
  return MaterialApp(
    home: Scaffold(
      body: SingleChildScrollView(
        child: SetNewPasswordStep(
          temporaryPassword: _kTemp,
          busy: busy,
          serverError: serverError,
          onEdited: () => calls.edited++,
          onSubmit: (String password) async {
            calls.submitted.add(password);
            return calls.answer;
          },
          onBack: () => calls.back++,
        ),
      ),
    ),
  );
}

void _phoneViewport(WidgetTester tester) {
  // A 360×800dp budget handset.
  tester.view.physicalSize = const Size(1080, 2400);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
}

Finder _inRule(NewPasswordRule rule, IconData icon) => find.descendant(
      of: find.byKey(passwordRuleKey(rule)),
      matching: find.byIcon(icon),
    );

bool _ticked(NewPasswordRule rule) =>
    _inRule(rule, Icons.check_circle_rounded).evaluate().isNotEmpty &&
    _inRule(rule, Icons.circle_rounded).evaluate().isEmpty;

TextEditingController _controllerOf(WidgetTester tester, Key key) =>
    tester.widget<TextField>(find.byKey(key)).controller!;

Future<void> _tap(WidgetTester tester, Key key) async {
  await tester.ensureVisible(find.byKey(key));
  await tester.pump();
  await tester.tap(find.byKey(key));
  await tester.pump();
}

/// The [AnimatedSwitcher] that morphs [rule]'s tick.
AnimatedSwitcher _tickSwitcher(WidgetTester tester, NewPasswordRule rule) =>
    tester.widget<AnimatedSwitcher>(find.descendant(
      of: find.byKey(passwordRuleKey(rule)),
      matching: find.byType(AnimatedSwitcher),
    ));

/// What the app told the OS autofill service, in order: `true` commits (the
/// OS may offer to save), `false` cancels.
List<bool> _autofillFinishes(WidgetTester tester) => tester.testTextInput.log
    .where((MethodCall c) => c.method == 'TextInput.finishAutofillContext')
    .map((MethodCall c) => c.arguments as bool)
    .toList();

void main() {
  group('NewPasswordRule', () {
    bool met(NewPasswordRule r, String pw, [String confirm = '']) =>
        r.isMetBy(password: pw, confirm: confirm, temporaryPassword: _kTemp);

    test('mirrors the server policy: 8–128 chars, a letter and a digit', () {
      expect(met(NewPasswordRule.minLength, 'abcdef1'), isFalse);
      expect(met(NewPasswordRule.minLength, 'abcdefg1'), isTrue);
      expect(met(NewPasswordRule.maxLength, 'a' * 128), isTrue);
      expect(met(NewPasswordRule.maxLength, 'a' * 129), isFalse);
      expect(met(NewPasswordRule.letter, '12345678'), isFalse);
      // Only ASCII letters count, exactly like the server's [A-Za-z].
      expect(met(NewPasswordRule.letter, 'पासवर्ड123'), isFalse);
      expect(met(NewPasswordRule.letter, '1234567a'), isTrue);
      expect(met(NewPasswordRule.number, 'abcdefgh'), isFalse);
      expect(met(NewPasswordRule.number, 'abcdefg9'), isTrue);
    });

    test('step rules: not the temporary password, and confirm matches', () {
      expect(met(NewPasswordRule.notTemporary, _kTemp), isFalse);
      expect(met(NewPasswordRule.notTemporary, 'MyOwnPass1'), isTrue);
      expect(met(NewPasswordRule.confirmMatches, 'MyOwnPass1', 'MyOwnPass'),
          isFalse);
      expect(met(NewPasswordRule.confirmMatches, 'MyOwnPass1', 'MyOwnPass1'),
          isTrue);
    });

    test('an empty password meets nothing (no tick before typing)', () {
      for (final NewPasswordRule rule in NewPasswordRule.values) {
        expect(met(rule, ''), isFalse, reason: rule.name);
      }
    });
  });

  group('SetNewPasswordStep', () {
    testWidgets('rules tick off as each is met', (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls();
      await tester.pumpWidget(_host(calls));
      await tester.pumpAndSettle();

      for (final NewPasswordRule rule in NewPasswordRule.values) {
        expect(_ticked(rule), isFalse, reason: 'untouched ${rule.name}');
      }

      await tester.enterText(find.byKey(_kNew), 'abc');
      await tester.pumpAndSettle();
      expect(_ticked(NewPasswordRule.letter), isTrue);
      expect(_ticked(NewPasswordRule.maxLength), isTrue);
      expect(_ticked(NewPasswordRule.notTemporary), isTrue);
      expect(_ticked(NewPasswordRule.minLength), isFalse);
      expect(_ticked(NewPasswordRule.number), isFalse);
      expect(_ticked(NewPasswordRule.confirmMatches), isFalse);

      await tester.enterText(find.byKey(_kNew), 'MyOwnPass1');
      await tester.pumpAndSettle();
      for (final NewPasswordRule rule in <NewPasswordRule>[
        NewPasswordRule.minLength,
        NewPasswordRule.maxLength,
        NewPasswordRule.letter,
        NewPasswordRule.number,
        NewPasswordRule.notTemporary,
      ]) {
        expect(_ticked(rule), isTrue, reason: rule.name);
      }
      expect(_ticked(NewPasswordRule.confirmMatches), isFalse);

      await tester.enterText(find.byKey(_kConfirm), 'MyOwnPass1');
      await tester.pumpAndSettle();
      expect(_ticked(NewPasswordRule.confirmMatches), isTrue);

      // Typing the temporary password back un-ticks its rule.
      await tester.enterText(find.byKey(_kNew), _kTemp);
      await tester.pumpAndSettle();
      expect(_ticked(NewPasswordRule.notTemporary), isFalse);
      expect(_ticked(NewPasswordRule.confirmMatches), isFalse);
    });

    testWidgets('a tick morphs in over 160ms (fade + scale)',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      await tester.pumpWidget(_host(_Calls()));
      await tester.pumpAndSettle();

      // The issue's 160ms, from the shared motion tokens (#2591).
      expect(AppMotion.morph, const Duration(milliseconds: 160));
      expect(_tickSwitcher(tester, NewPasswordRule.letter).duration,
          AppMotion.morph);

      await tester.enterText(find.byKey(_kNew), 'a');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 80));
      // Mid-morph: the dot is leaving while the check arrives.
      expect(_inRule(NewPasswordRule.letter, Icons.circle_rounded),
          findsOneWidget);
      expect(_inRule(NewPasswordRule.letter, Icons.check_circle_rounded),
          findsOneWidget);
      final double midOpacity = tester
          .widget<FadeTransition>(find
              .ancestor(
                of: _inRule(NewPasswordRule.letter, Icons.check_circle_rounded),
                matching: find.byType(FadeTransition),
              )
              .first)
          .opacity
          .value;
      expect(midOpacity, inExclusiveRange(0, 1));

      await tester.pump(const Duration(milliseconds: 90));
      expect(_ticked(NewPasswordRule.letter), isTrue);
    });

    testWidgets('reduced motion: the tick swaps instantly',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(
          tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      await tester.pumpWidget(_host(_Calls()));
      await tester.pump();
      expect(_tickSwitcher(tester, NewPasswordRule.letter).duration,
          Duration.zero);

      await tester.enterText(find.byKey(_kNew), 'a');
      await tester.pump();
      expect(_ticked(NewPasswordRule.letter), isTrue);
    });

    testWidgets('a screen reader hears each rule and whether it is done',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(_Calls()));
      await tester.pumpAndSettle();

      expect(
        tester
            .getSemantics(find.byKey(passwordRuleKey(NewPasswordRule.number))),
        matchesSemantics(label: 'At least one number: not yet'),
      );
      await tester.enterText(find.byKey(_kNew), 'abc1');
      await tester.pumpAndSettle();
      expect(
        tester
            .getSemantics(find.byKey(passwordRuleKey(NewPasswordRule.number))),
        matchesSemantics(label: 'At least one number: done'),
      );
      handle.dispose();
    });

    testWidgets('a weak password is refused inline and nothing is sent',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls();
      await tester.pumpWidget(_host(calls));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(_kNew), 'abc');
      await tester.enterText(find.byKey(_kConfirm), 'abc');
      await _tap(tester, _kSubmit);

      expect(find.text('Use at least 8 characters.'), findsOneWidget);
      expect(calls.submitted, isEmpty);
    });

    testWidgets('the temporary password is refused inline',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls();
      await tester.pumpWidget(_host(calls));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(_kNew), _kTemp);
      await tester.enterText(find.byKey(_kConfirm), _kTemp);
      await _tap(tester, _kSubmit);

      expect(
        find.text(
            'Choose a different password. It cannot be the temporary one.'),
        findsOneWidget,
      );
      expect(calls.submitted, isEmpty);
    });

    testWidgets('a mismatched confirm is refused inline on the confirm field',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls();
      await tester.pumpWidget(_host(calls));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(_kNew), 'MyOwnPass1');
      await tester.enterText(find.byKey(_kConfirm), 'MyOwnPass2');
      await tester.pumpAndSettle();
      expect(_ticked(NewPasswordRule.confirmMatches), isFalse);
      await _tap(tester, _kSubmit);

      expect(find.text('Passwords do not match.'), findsOneWidget);
      expect(calls.submitted, isEmpty);
      // Fixing the confirm clears its error.
      await tester.enterText(find.byKey(_kConfirm), 'MyOwnPass1');
      await tester.pumpAndSettle();
      expect(find.text('Passwords do not match.'), findsNothing);
      expect(_ticked(NewPasswordRule.confirmMatches), isTrue);
    });

    testWidgets('the server reason shows inline; editing reports it stale',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls();
      await tester.pumpWidget(_host(calls,
          serverError:
              'Password must include at least one letter and one digit.'));
      await tester.pumpAndSettle();

      // The inline error is drawn by BbFieldError under the field (#2595).
      expect(
        find.descendant(
          of: find.byType(BbFieldError),
          matching: find.text(
              'Password must include at least one letter and one digit.'),
        ),
        findsOneWidget,
      );

      await tester.enterText(find.byKey(_kNew), 'x');
      await tester.pump();
      expect(calls.edited, 1);
    });

    testWidgets('keyboard: Next moves to confirm, Done submits',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls();
      await tester.pumpWidget(_host(calls));
      await tester.pumpAndSettle();

      // The step focuses the new-password field on arrival.
      expect(tester.widget<TextField>(find.byKey(_kNew)).focusNode!.hasFocus,
          isTrue);
      await tester.enterText(find.byKey(_kNew), 'MyOwnPass1');
      await tester.testTextInput.receiveAction(TextInputAction.next);
      await tester.pump();
      expect(
          tester.widget<TextField>(find.byKey(_kConfirm)).focusNode!.hasFocus,
          isTrue);

      await tester.enterText(find.byKey(_kConfirm), 'MyOwnPass1');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(calls.submitted, <String>['MyOwnPass1']);
    });

    testWidgets('both fields are cleared once the payer is signed in',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls()..answer = true;
      await tester.pumpWidget(_host(calls));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(_kNew), 'MyOwnPass1');
      await tester.enterText(find.byKey(_kConfirm), 'MyOwnPass1');
      await _tap(tester, _kSubmit);
      await tester.pump();

      expect(calls.submitted, <String>['MyOwnPass1']);
      expect(_controllerOf(tester, _kNew).text, isEmpty);
      expect(_controllerOf(tester, _kConfirm).text, isEmpty);
    });

    testWidgets('a refusal keeps what was typed', (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls(); // answers false
      await tester.pumpWidget(_host(calls));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(_kNew), 'MyOwnPass1');
      await tester.enterText(find.byKey(_kConfirm), 'MyOwnPass1');
      await _tap(tester, _kSubmit);
      await tester.pump();

      expect(_controllerOf(tester, _kNew).text, 'MyOwnPass1');
    });

    testWidgets('both fields are one new-password autofill context',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      await tester.pumpWidget(_host(_Calls()));
      await tester.pumpAndSettle();

      for (final Key key in <Key>[_kNew, _kConfirm]) {
        expect(tester.widget<TextField>(find.byKey(key)).autofillHints,
            <String>[AutofillHints.newPassword],
            reason: '$key');
      }
      final AutofillGroupState? group =
          AutofillGroup.maybeOf(tester.element(find.byKey(_kNew)));
      expect(group, isNotNull);
      expect(AutofillGroup.maybeOf(tester.element(find.byKey(_kConfirm))),
          same(group));
      // Leaving the step must never offer an unaccepted password for saving.
      expect(group!.widget.onDisposeAction, AutofillContextAction.cancel);
    });

    testWidgets('signed in: autofill is committed before the fields clear',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls()..answer = true;
      await tester.pumpWidget(_host(calls));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(_kNew), 'MyOwnPass1');
      await tester.enterText(find.byKey(_kConfirm), 'MyOwnPass1');
      tester.testTextInput.log.clear();

      await _tap(tester, _kSubmit);
      await tester.pump();

      expect(_autofillFinishes(tester), <bool>[true]);
      // The OS reads the context while it still holds the accepted password:
      // the commit goes out before the focused field is cleared.
      final List<MethodCall> log = tester.testTextInput.log;
      final int commit = log.indexWhere(
          (MethodCall c) => c.method == 'TextInput.finishAutofillContext');
      final int cleared = log.indexWhere((MethodCall c) =>
          c.method == 'TextInput.setEditingState' &&
          (c.arguments as Map<Object?, Object?>)['text'] == '');
      expect(cleared, greaterThan(commit));
    });

    testWidgets('not signed in, or left: autofill is cancelled, never saved',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls(); // answers false
      await tester.pumpWidget(_host(calls));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(_kNew), 'MyOwnPass1');
      await tester.enterText(find.byKey(_kConfirm), 'MyOwnPass1');

      await _tap(tester, _kSubmit);
      await tester.pump();
      expect(calls.submitted, <String>['MyOwnPass1']);
      expect(_autofillFinishes(tester), isEmpty);

      // The step goes away (Back, a 401, …): the context is cancelled.
      await tester.pumpWidget(const SizedBox());
      expect(_autofillFinishes(tester), <bool>[false]);
    });

    testWidgets('busy: the CTA spins, Back is disabled, no double send',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls();
      await tester.pumpWidget(_host(calls, busy: true));
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(tester.widget<TextButton>(find.byKey(_kBack)).onPressed, isNull);
      await tester.enterText(find.byKey(_kNew), 'MyOwnPass1');
      await tester.enterText(find.byKey(_kConfirm), 'MyOwnPass1');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(calls.submitted, isEmpty);
    });

    testWidgets('Back to sign in reports the abandon',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final _Calls calls = _Calls();
      await tester.pumpWidget(_host(calls));
      await tester.pumpAndSettle();

      await _tap(tester, _kBack);
      expect(calls.back, 1);
    });

    testWidgets('targets meet the 48dp floor and are labelled',
        (WidgetTester tester) async {
      _phoneViewport(tester);
      final SemanticsHandle handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(_Calls()));
      await tester.pumpAndSettle();

      await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
      await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
      handle.dispose();
    });
  });

  group('NewPasswordStepSwitcher', () {
    const Key a = Key('side_a');
    const Key b = Key('side_b');

    Widget switcher(Key side) => MaterialApp(
          home: Scaffold(
            body: NewPasswordStepSwitcher(
              child: SizedBox(key: side, height: 40, width: 40),
            ),
          ),
        );

    double opacityOf(WidgetTester tester, Key side) => tester
        .widget<FadeTransition>(find
            .ancestor(
                of: find.byKey(side), matching: find.byType(FadeTransition))
            .first)
        .opacity
        .value;

    double riseOf(WidgetTester tester, Key side) => tester
        .widget<Transform>(find
            .ancestor(of: find.byKey(side), matching: find.byType(Transform))
            .first)
        .transform
        .getTranslation()
        .y;

    AnimatedSwitcher switcherOf(WidgetTester tester) =>
        tester.widget<AnimatedSwitcher>(find.descendant(
          of: find.byType(NewPasswordStepSwitcher),
          matching: find.byType(AnimatedSwitcher),
        ));

    testWidgets('the step slides in over 300ms: opacity + ≤6px only',
        (WidgetTester tester) async {
      await tester.pumpWidget(switcher(a));
      await tester.pumpWidget(switcher(b));
      // The shared tokens (#2591): in on the page duration, out on fast.
      expect(AppMotion.page, const Duration(milliseconds: 300));
      expect(switcherOf(tester).duration, AppMotion.page);
      expect(switcherOf(tester).reverseDuration, AppMotion.fast);

      expect(opacityOf(tester, b), 0);
      expect(riseOf(tester, b), 6);

      await tester.pump(const Duration(milliseconds: 150));
      expect(opacityOf(tester, b), inExclusiveRange(0, 1));
      expect(riseOf(tester, b), inExclusiveRange(0, 6));
      // The side that leaves is quicker (140ms) and already gone.
      expect(find.byKey(a), findsNothing);

      await tester.pump(const Duration(milliseconds: 150));
      expect(opacityOf(tester, b), 1);
      expect(riseOf(tester, b), 0);
      // The ticker retires on the frame after its 300ms end; nothing loops.
      await tester.pump(const Duration(milliseconds: 1));
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('reduced motion: the swap is instant',
        (WidgetTester tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(disableAnimations: true);
      addTearDown(
          tester.platformDispatcher.clearAccessibilityFeaturesTestValue);
      await tester.pumpWidget(switcher(a));
      await tester.pumpWidget(switcher(b));
      await tester.pump();

      expect(switcherOf(tester).duration, Duration.zero);
      expect(switcherOf(tester).reverseDuration, Duration.zero);
      expect(find.byKey(a), findsNothing);
      expect(opacityOf(tester, b), 1);
      expect(riseOf(tester, b), 0);
      expect(tester.hasRunningAnimations, isFalse);
    });
  });
}

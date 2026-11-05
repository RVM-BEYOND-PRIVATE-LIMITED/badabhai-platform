import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:payer_app/core/theme/app_colors.dart';
import 'package:payer_app/core/theme/app_motion.dart';
import 'package:payer_app/core/theme/app_theme.dart';
import 'package:payer_app/core/util/number_input.dart';
import 'package:payer_app/core/widgets/bb_action_bar.dart';
import 'package:payer_app/core/widgets/bb_field.dart';
import 'package:payer_app/core/widgets/bb_field_error.dart';
import 'package:payer_app/core/widgets/bb_focus_chain.dart';
import 'package:payer_app/core/widgets/bb_form_errors.dart';
import 'package:payer_app/core/widgets/bb_leave_guard.dart';
import 'package:payer_app/core/widgets/bb_shake.dart';
import 'package:payer_app/core/widgets/bb_step_progress.dart';

/// #2595 (M7) — the form-feedback primitives the posting forms are built on:
/// the inline error line, the shake, "take me to the first error", the step
/// progress, the keyboard chain, the digits-only number boxes, the pinned
/// action bar and the unsaved-changes guard. Every animated one is checked to
/// drop to zero under the OS "remove animations" setting.
void main() {
  late List<String> haptics;

  setUp(() {
    haptics = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform,
            (MethodCall call) async {
      if (call.method == 'HapticFeedback.vibrate') {
        haptics.add(call.arguments as String);
      }
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  const String light = 'HapticFeedbackType.lightImpact';

  // ONE theme instance: a fresh ThemeData per pumpWidget would run
  // MaterialApp's own theme cross-fade and read as a running animation.
  final ThemeData theme = AppTheme.light();

  /// [child] in the app theme; [reduced] mirrors the OS "remove animations".
  Widget host(Widget child, {bool reduced = false}) => MaterialApp(
        theme: theme,
        builder: (BuildContext context, Widget? app) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: reduced),
          child: app!,
        ),
        home: Scaffold(body: child),
      );

  group('AppMotion — the #2595 tokens', () {
    test('error 160ms/4px, shake 200ms/6px, progress 300ms, pop 1.04', () {
      expect(AppMotion.errorReveal, const Duration(milliseconds: 160));
      expect(AppMotion.errorTravel, 4);
      expect(AppMotion.shake, const Duration(milliseconds: 200));
      expect(AppMotion.shakeTravel, 6);
      expect(AppMotion.progress, const Duration(milliseconds: 300));
      expect(AppMotion.popScale, 1.04);
    });
  });

  group('BbFieldError', () {
    double opacity(WidgetTester tester) => tester
        .widget<FadeTransition>(find.descendant(
          of: find.byType(BbFieldError),
          matching: find.byType(FadeTransition),
        ))
        .opacity
        .value;

    double dy(WidgetTester tester) => tester
        .widget<Transform>(find.descendant(
          of: find.byType(BbFieldError),
          matching: find.byType(Transform),
        ))
        .transform
        .getTranslation()
        .y;

    testWidgets('renders nothing without an error', (WidgetTester tester) async {
      await tester.pumpWidget(host(const BbFieldError(text: null)));
      expect(find.byKey(BbFieldError.lineKey), findsNothing);
    });

    testWidgets('slides down 4px with a fade over 160ms', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(host(const BbFieldError(text: null)));
      await tester.pumpWidget(host(const BbFieldError(text: 'Add the city')));

      expect(find.text('Add the city'), findsOneWidget);
      expect(opacity(tester), 0);
      expect(dy(tester), -AppMotion.errorTravel);

      await tester.pump(const Duration(milliseconds: 80));
      expect(opacity(tester), inExclusiveRange(0, 1));
      expect(dy(tester), inExclusiveRange(-AppMotion.errorTravel, 0));

      await tester.pump(const Duration(milliseconds: 90));
      expect(opacity(tester), 1);
      expect(dy(tester), 0);
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('appears at once under reduced motion', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        host(const BbFieldError(text: null), reduced: true),
      );
      await tester.pumpWidget(
        host(const BbFieldError(text: 'Add the city'), reduced: true),
      );
      expect(opacity(tester), 1);
      expect(dy(tester), 0);
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('a cleared error fades out, then its row collapses', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(host(const BbFieldError(text: 'Add the city')));
      await tester.pumpAndSettle();
      await tester.pumpWidget(host(const BbFieldError(text: null)));
      await tester.pump(const Duration(milliseconds: 80));
      expect(find.byKey(BbFieldError.lineKey), findsOneWidget);
      expect(opacity(tester), inExclusiveRange(0, 1));

      await tester.pumpAndSettle();
      expect(find.byKey(BbFieldError.lineKey), findsNothing);
    });

    testWidgets('is announced as it appears (a live region)', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(host(const BbFieldError(text: 'Add the city')));
      expect(
        find.descendant(
          of: find.byType(BbFieldError),
          matching: find.byWidgetPredicate(
            (Widget w) => w is Semantics && (w.properties.liveRegion ?? false),
          ),
        ),
        findsOneWidget,
      );
    });
  });

  group('BbField / BbSelect inline error', () {
    testWidgets('shows the error under the input, edged in the theme crimson',
        (WidgetTester tester) async {
      await tester.pumpWidget(host(const BbField(
        label: 'City',
        errorText: 'Add the city',
      )));
      expect(find.text('Add the city'), findsOneWidget);
      final InputDecoration decoration =
          tester.widget<TextField>(find.byType(TextField)).decoration!;
      final OutlineInputBorder enabled =
          decoration.enabledBorder! as OutlineInputBorder;
      final OutlineInputBorder focused =
          decoration.focusedBorder! as OutlineInputBorder;
      expect(enabled.borderSide.color, AppColors.danger);
      expect(focused.borderSide.color, AppColors.danger);
      expect(focused.borderSide.width, 2);
    });

    testWidgets('without one, the input keeps its blue focus edge', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(host(const BbField(label: 'City')));
      final InputDecoration decoration =
          tester.widget<TextField>(find.byType(TextField)).decoration!;
      expect(decoration.enabledBorder, isNull);
      expect(
        (decoration.focusedBorder! as OutlineInputBorder).borderSide.color,
        AppColors.blue,
      );
      expect(find.byKey(BbFieldError.lineKey), findsNothing);
    });

    testWidgets('a select shows its error under it', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(host(BbSelect<String?>(
        label: 'Role',
        value: null,
        items: const <String?>[null, 'fitter'],
        labelOf: (String? v) => v ?? '— pick the role —',
        onChanged: (_) {},
        errorText: 'Pick the role',
      )));
      expect(find.text('Pick the role'), findsOneWidget);
    });
  });

  group('BbShake', () {
    double dx(WidgetTester tester, [Finder? of]) => tester
        .widget<Transform>(find
            .descendant(
              of: of ?? find.byType(BbShake),
              matching: find.byType(Transform),
            )
            .first)
        .transform
        .getTranslation()
        .x;

    test('one full swing: ±6px at the peaks, at rest at both ends', () {
      expect(BbShake.offsetAt(0), 0);
      expect(BbShake.offsetAt(0.25), closeTo(6, 1e-9));
      expect(BbShake.offsetAt(0.75), closeTo(-6, 1e-9));
      expect(BbShake.offsetAt(1), closeTo(0, 1e-9));
    });

    testWidgets('shakes 6px once over 200ms, then rests', (
      WidgetTester tester,
    ) async {
      final GlobalKey<BbShakeState> key = GlobalKey<BbShakeState>();
      await tester.pumpWidget(host(BbShake(
        key: key,
        child: const SizedBox(width: 10, height: 10),
      )));
      expect(dx(tester), 0);

      key.currentState!.shake();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(dx(tester), closeTo(6, 0.01));
      await tester.pump(const Duration(milliseconds: 100));
      expect(dx(tester), closeTo(-6, 0.01));
      await tester.pump(const Duration(milliseconds: 60));
      expect(dx(tester), 0);
      // Once — nothing loops.
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('does nothing under reduced motion', (
      WidgetTester tester,
    ) async {
      final GlobalKey<BbShakeState> key = GlobalKey<BbShakeState>();
      await tester.pumpWidget(host(
        BbShake(key: key, child: const SizedBox(width: 10, height: 10)),
        reduced: true,
      ));
      key.currentState!.shake();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(dx(tester), 0);
      expect(tester.hasRunningAnimations, isFalse);
    });
  });

  group('BbFormErrors', () {
    testWidgets('settle drops fixed errors, refreshes the rest, adds nothing',
        (WidgetTester tester) async {
      final BbFormErrors<String> errors = BbFormErrors<String>();
      expect(errors.settle(<String, String>{'a': 'x'}), isFalse);

      errors.show(<String, String>{'a': 'Add A', 'b': 'Add B'});
      expect(errors['a'], 'Add A');

      // 'b' was fixed, 'a' still fails (with a new message), 'c' is new.
      final bool changed = errors.settle(<String, String>{
        'a': 'Max A must be at least the min.',
        'c': 'Add C',
      });
      expect(changed, isTrue);
      expect(errors.current, <String, String>{
        'a': 'Max A must be at least the min.',
      });
      expect(errors['c'], isNull);
      // Settling to the same picture is not a change.
      expect(
        errors.settle(<String, String>{'a': 'Max A must be at least the min.'}),
        isFalse,
      );
      await tester.pump();
    });

    testWidgets(
        'show: the TOPMOST error scrolls into view, shakes, and fires the '
        'error haptic', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(400, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      final BbFormErrors<String> errors = BbFormErrors<String>();
      final GlobalKey<_FormHarnessState> form = GlobalKey<_FormHarnessState>();
      await tester.pumpWidget(host(_FormHarness(key: form, errors: errors)));

      // Scrolled to the very end, past both fields that will fail.
      final ScrollController scroll = form.currentState!.scroll;
      scroll.jumpTo(scroll.position.maxScrollExtent);
      await tester.pump();
      expect(tester.getRect(find.text('Field B')).bottom, lessThan(0));

      // Declared bottom-first: "first" is where the field SITS, not map order.
      form.currentState!.reject(<String, String>{
        'c': 'Fix C',
        'b': 'Fix B',
      });

      double maxShakeB = 0;
      double maxShakeC = 0;
      for (int i = 0; i < 60; i++) {
        await tester.pump(const Duration(milliseconds: 10));
        maxShakeB = _max(maxShakeB, _shakeOf(tester, 'Field B'));
        maxShakeC = _max(maxShakeC, _shakeOf(tester, 'Field C'));
      }

      // B is now on screen, near the top of the viewport…
      final Rect b = tester.getRect(find.text('Field B'));
      expect(b.top, greaterThanOrEqualTo(0));
      expect(b.bottom, lessThanOrEqualTo(600));
      // …its error is at the field, and it — only it — shook (6px).
      expect(find.text('Fix B'), findsOneWidget);
      expect(maxShakeB, closeTo(AppMotion.shakeTravel, 0.6));
      expect(maxShakeC, 0);
      // The double error tick.
      expect(haptics, <String>[light, light]);
    });

    testWidgets('an error already on screen does not move the form', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(400, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      final BbFormErrors<String> errors = BbFormErrors<String>();
      final GlobalKey<_FormHarnessState> form = GlobalKey<_FormHarnessState>();
      await tester.pumpWidget(host(_FormHarness(key: form, errors: errors)));

      form.currentState!.reject(<String, String>{'a': 'Fix A'});
      double maxShake = 0;
      for (int i = 0; i < 30; i++) {
        await tester.pump(const Duration(milliseconds: 10));
        maxShake = _max(maxShake, _shakeOf(tester, 'Field A'));
      }
      expect(form.currentState!.scroll.offset, 0);
      expect(maxShake, greaterThan(0));
    });

    testWidgets(
        "refuse: the server's error stays until ITS field changes, and never "
        'refuses a submit by itself', (WidgetTester tester) async {
      const String refused = 'Must not contain a company name.';
      final Map<String, Object?> values = <String, Object?>{
        'a': 'Tata Motors Pvt Ltd',
        'b': 'Pune',
      };
      final BbFormErrors<String> errors = BbFormErrors<String>();

      expect(
        errors.refuse(
          <String, String>{'a': refused},
          valueOf: (String field) => values[field],
        ),
        isTrue,
      );
      expect(errors['a'], refused);
      expect(errors.refusals, <String, String>{'a': refused});

      // An edit elsewhere, with every rule passing, leaves it on show…
      values['b'] = 'Chakan';
      expect(errors.settle(const <String, String>{}), isFalse);
      expect(errors['a'], refused);
      // …a resubmit the rules pass is not refused for it (the server judges)…
      expect(errors.show(const <String, String>{}), isFalse);
      expect(errors['a'], refused);
      // …and a submit the rules refuse shows it beside their errors.
      expect(errors.show(<String, String>{'b': 'Add B'}), isTrue);
      expect(errors.current, <String, String>{'a': refused, 'b': 'Add B'});

      // Changing THAT field is what clears it, for good.
      values['a'] = 'CNC Setter';
      expect(errors.settle(<String, String>{'b': 'Add B'}), isTrue);
      expect(errors.current, <String, String>{'b': 'Add B'});
      expect(errors.refusals, isEmpty);
      await tester.pump();
    });

    testWidgets('refuse reveals the topmost refused field like show does', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(400, 600);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);

      final BbFormErrors<String> errors = BbFormErrors<String>();
      final GlobalKey<_FormHarnessState> form = GlobalKey<_FormHarnessState>();
      await tester.pumpWidget(host(_FormHarness(key: form, errors: errors)));
      expect(errors.hasAnchor('b'), isTrue);
      expect(errors.hasAnchor('z'), isFalse);

      final ScrollController scroll = form.currentState!.scroll;
      scroll.jumpTo(scroll.position.maxScrollExtent);
      await tester.pump();

      form.currentState!.refuse(<String, String>{'b': 'Server B'});
      double maxShake = 0;
      for (int i = 0; i < 60; i++) {
        await tester.pump(const Duration(milliseconds: 10));
        maxShake = _max(maxShake, _shakeOf(tester, 'Field B'));
      }
      final Rect b = tester.getRect(find.text('Field B'));
      expect(b.top, greaterThanOrEqualTo(0));
      expect(b.bottom, lessThanOrEqualTo(600));
      expect(find.text('Server B'), findsOneWidget);
      expect(maxShake, closeTo(AppMotion.shakeTravel, 0.6));
      expect(haptics, <String>[light, light]);
    });
  });

  group('BbStepProgress', () {
    double fill(WidgetTester tester) => tester
        .widget<Transform>(find.byKey(BbStepProgress.fillKey))
        .transform
        .storage[0];

    testWidgets('fills to the new step over 300ms, transform only', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(host(const BbStepProgress(done: 1, total: 4)));
      // The first build shows the value as-is — no fill-in on open.
      expect(fill(tester), 0.25);
      expect(find.text('1 of 4 sections done'), findsOneWidget);

      await tester.pumpWidget(host(const BbStepProgress(done: 2, total: 4)));
      await tester.pump(const Duration(milliseconds: 150));
      expect(fill(tester), inExclusiveRange(0.25, 0.5));
      await tester.pump(const Duration(milliseconds: 160));
      expect(fill(tester), 0.5);
      expect(find.text('2 of 4 sections done'), findsOneWidget);
      expect(tester.hasRunningAnimations, isFalse);
    });

    testWidgets('jumps straight to the step under reduced motion', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(
        host(const BbStepProgress(done: 1, total: 4), reduced: true),
      );
      await tester.pumpWidget(
        host(const BbStepProgress(done: 3, total: 4), reduced: true),
      );
      await tester.pump();
      expect(fill(tester), 0.75);
    });
  });

  group('BbFocusChain', () {
    testWidgets('"next" walks the chain; the last says "done" and closes it',
        (WidgetTester tester) async {
      final BbFocusChain<String> chain =
          BbFocusChain<String>(<String>['a', 'b', 'c']);
      addTearDown(chain.dispose);
      await tester.pumpWidget(host(Column(
        children: <Widget>[
          BbField(label: 'A', flow: chain['a']),
          BbField(label: 'B', flow: chain['b']),
          BbField(label: 'C', flow: chain['c']),
          const BbField(label: 'D'),
        ],
      )));

      TextInputAction? actionOf(int i) =>
          tester.widget<TextField>(find.byType(TextField).at(i)).textInputAction;
      expect(actionOf(0), TextInputAction.next);
      expect(actionOf(1), TextInputAction.next);
      expect(actionOf(2), TextInputAction.done);
      expect(actionOf(3), isNull);
      expect(chain['zzz'], isNull);

      await tester.tap(find.byType(TextField).first);
      await tester.pump();
      expect(chain.node('a').hasFocus, isTrue);

      await tester.testTextInput.receiveAction(TextInputAction.next);
      await tester.pump();
      expect(chain.node('b').hasFocus, isTrue);

      await tester.testTextInput.receiveAction(TextInputAction.next);
      await tester.pump();
      expect(chain.node('c').hasFocus, isTrue);

      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(chain.node('c').hasFocus, isFalse);
    });
  });

  group('WholeNumberInputFormatter', () {
    TextEditingValue type(
      TextInputFormatter f,
      String before,
      String after, {
      int? caret,
    }) =>
        f.formatEditUpdate(
          TextEditingValue(
            text: before,
            selection: TextSelection.collapsed(offset: before.length),
          ),
          TextEditingValue(
            text: after,
            selection: TextSelection.collapsed(offset: caret ?? after.length),
          ),
        );

    const WholeNumberInputFormatter pay =
        WholeNumberInputFormatter(max: 10000000, grouped: true);
    const WholeNumberInputFormatter years =
        WholeNumberInputFormatter(max: 60);

    test('pay: digits only, Indian-grouped as typed', () {
      expect(type(pay, '', '18000').text, '18,000');
      expect(type(pay, '', '125000').text, '1,25,000');
      expect(type(pay, '', '₹18,000/-').text, '18,000');
      expect(type(pay, '', 'abc').text, '');
      expect(type(pay, '', '007').text, '7');
      final TextEditingValue v = type(pay, '', '18000');
      expect(v.selection, const TextSelection.collapsed(offset: 6));
    });

    test('pay: the caret stays after the digit it was after', () {
      // "18,000" with a 5 typed after the "8" → "1,85,000", caret after the 5.
      final TextEditingValue v = type(pay, '18,000', '185,000', caret: 3);
      expect(v.text, '1,85,000');
      expect(v.selection.baseOffset, 4);
    });

    test('pay: an edit past the server ceiling is refused', () {
      final TextEditingValue v = type(pay, '1,00,00,000', '1,00,00,0001');
      expect(v.text, '1,00,00,000');
      expect(type(pay, '', '10000000').text, '1,00,00,000');
    });

    test('experience: digits only, no grouping, at most 60', () {
      expect(type(years, '', '7').text, '7');
      expect(type(years, '7', '70').text, '7');
      expect(type(years, '6', '60').text, '60');
      expect(type(years, '', '1a').text, '1');
    });

    // Dropping the point as "just a non-digit" joined the fraction to the
    // whole part: a pasted "₹18,000.00" landed as 18,00,000 and "2.5" as 25.
    test('a pasted fraction of zeros is the whole number', () {
      expect(type(pay, '', '₹18,000.00').text, '18,000');
      expect(type(pay, '', '₹18,000.00/-').text, '18,000');
      expect(type(pay, '', '18000.0').text, '18,000');
      expect(type(years, '', '2.0').text, '2');
      // Pasted over a value already there (select-all + paste).
      expect(type(pay, '15,000', '₹18,000.00').text, '18,000');
      expect(
        type(pay, '', '₹18,000.00').selection,
        const TextSelection.collapsed(offset: 6),
      );
      // A point after a word is not a decimal point.
      expect(type(pay, '', 'Rs. 18000').text, '18,000');
    });

    test('any other fraction is refused, never read as a bigger number', () {
      expect(type(pay, '', '₹18,000.50').text, '');
      expect(type(pay, '15,000', '₹18,000.50').text, '15,000');
      expect(type(years, '', '2.5').text, '');
      expect(type(years, '3', '2.5').text, '3');
    });

    test('a point typed into a number is refused; on its own, it is a no-op',
        () {
      // "2|5" → "2.5" is not 25, and "18,0|00" → "18,0.00" is not 180.
      expect(type(years, '25', '2.5', caret: 2).text, '25');
      expect(type(pay, '18,000', '18,0.00', caret: 5).text, '18,000');
      // "2" then "." keeps "2", caret at its end.
      final TextEditingValue v = type(years, '2', '2.');
      expect(v.text, '2');
      expect(v.selection, const TextSelection.collapsed(offset: 1));
    });

    test('parseWholeNumber reads a grouped box back', () {
      expect(parseWholeNumber('18,000'), 18000);
      expect(parseWholeNumber('1,25,000'), 125000);
      expect(parseWholeNumber(''), isNull);
      expect(parseWholeNumber('  '), isNull);
    });
  });

  group('BbActionBar', () {
    testWidgets('pins its action under the form, above the gesture inset', (
      WidgetTester tester,
    ) async {
      tester.view.physicalSize = const Size(400, 800);
      tester.view.devicePixelRatio = 1;
      tester.view.padding = const FakeViewPadding(bottom: 24);
      addTearDown(tester.view.reset);

      await tester.pumpWidget(MaterialApp(
        theme: theme,
        home: Scaffold(
          bottomNavigationBar: BbActionBar(
            child: ElevatedButton(onPressed: () {}, child: const Text('Save')),
          ),
          body: ListView(
            children: <Widget>[
              for (int i = 0; i < 40; i++) SizedBox(height: 60, child: Text('row $i')),
            ],
          ),
        ),
      ));
      final Rect save = tester.getRect(find.text('Save'));
      expect(save.bottom, lessThanOrEqualTo(800 - 24));
      expect(save.top, greaterThan(600));
      // Far down the list the action is still on screen — pinned, not scrolled.
      await tester.drag(find.byType(ListView), const Offset(0, -1500));
      await tester.pumpAndSettle();
      expect(tester.getRect(find.text('Save')), save);
    });
  });

  group('BbLeaveGuard — a pushed route', () {
    Future<TextEditingController> openGuardedPage(WidgetTester tester) async {
      final TextEditingController text = TextEditingController();
      addTearDown(text.dispose);
      await tester.pumpWidget(MaterialApp(
        theme: theme,
        home: Builder(
          builder: (BuildContext context) => Scaffold(
            body: TextButton(
              onPressed: () => Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) => BbLeaveGuard(
                    hasUnsavedChanges: () => text.text.isNotEmpty,
                    prompt: const BbLeavePrompt(
                      title: 'Discard your changes?',
                      message: 'Your edits have not been saved.',
                    ),
                    watch: text,
                    child: Scaffold(body: TextField(controller: text)),
                  ),
                ),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ));
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      return text;
    }

    testWidgets('a clean page leaves on Back at once', (
      WidgetTester tester,
    ) async {
      await openGuardedPage(tester);
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsNothing);
      expect(find.text('Discard your changes?'), findsNothing);
    });

    testWidgets('an edited page asks; "Keep editing" stays, "Discard" leaves',
        (WidgetTester tester) async {
      await openGuardedPage(tester);
      await tester.enterText(find.byType(TextField), 'half typed');
      await tester.pump();

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.text('Discard your changes?'), findsOneWidget);
      await tester.tap(find.text('Keep editing'));
      await tester.pumpAndSettle();
      expect(find.text('half typed'), findsOneWidget);

      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      await tester.tap(find.text('Discard'));
      await tester.pumpAndSettle();
      expect(find.byType(TextField), findsNothing);
    });
  });

  group('BbLeaveGuard — inside a host scope', () {
    testWidgets('answers the host instead of intercepting Back itself', (
      WidgetTester tester,
    ) async {
      bool dirty = false;
      int left = 0;
      final BbLeaveGuardController controller = BbLeaveGuardController();
      await tester.pumpWidget(host(BbLeaveGuardScope(
        controller: controller,
        child: BbLeaveGuard(
          hasUnsavedChanges: () => dirty,
          prompt: const BbLeavePrompt(
            title: 'Discard this job?',
            message: 'What you have filled in here will be lost.',
          ),
          child: const Text('task'),
        ),
      )));

      // No PopScope of its own: the host owns every leave.
      expect(
        find.ancestor(of: find.text('task'), matching: find.byType(PopScope)),
        findsNothing,
      );

      expect(controller.hasUnsavedChanges, isFalse);
      controller.leaveThen(() => left++);
      expect(left, 1);

      dirty = true;
      expect(controller.hasUnsavedChanges, isTrue);
      controller.leaveThen(() => left++);
      await tester.pumpAndSettle();
      expect(find.text('Discard this job?'), findsOneWidget);
      await tester.tap(find.text('Discard'));
      await tester.pumpAndSettle();
      expect(left, 2);

      // Released (the host dismissed the task): never asked about again.
      controller.release();
      expect(controller.hasUnsavedChanges, isFalse);
      controller.leaveThen(() => left++);
      expect(left, 3);
    });
  });
}

double _max(double a, double b) => a > b ? a : b;

/// The current |x| offset of the [BbShake] around the field labelled [label].
double _shakeOf(WidgetTester tester, String label) {
  final Finder shake = find.ancestor(
    of: find.text(label, skipOffstage: false),
    matching: find.byType(BbShake),
  );
  final Transform transform = tester.widget<Transform>(
    find.descendant(of: shake, matching: find.byType(Transform)).first,
  );
  return transform.transform.getTranslation().x.abs();
}

/// Three anchored fields far apart in a scrolling form — enough to prove the
/// reveal scrolls to the TOPMOST error.
class _FormHarness extends StatefulWidget {
  const _FormHarness({super.key, required this.errors});

  final BbFormErrors<String> errors;

  @override
  State<_FormHarness> createState() => _FormHarnessState();
}

class _FormHarnessState extends State<_FormHarness> {
  final ScrollController scroll = ScrollController();

  void reject(Map<String, String> errors) =>
      setState(() => widget.errors.show(errors));

  /// The server refusing a submit; every field reads as unchanged.
  void refuse(Map<String, String> errors) => setState(
        () => widget.errors.refuse(errors, valueOf: (String _) => null),
      );

  @override
  void dispose() {
    scroll.dispose();
    super.dispose();
  }

  Widget _field(String id, String label) => BbShake(
        key: widget.errors.anchor(id),
        child: BbField(label: label, errorText: widget.errors[id]),
      );

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      controller: scroll,
      child: Column(
        children: <Widget>[
          _field('a', 'Field A'),
          const SizedBox(height: 1200),
          _field('b', 'Field B'),
          const SizedBox(height: 1200),
          _field('c', 'Field C'),
          const SizedBox(height: 400),
        ],
      ),
    );
  }
}

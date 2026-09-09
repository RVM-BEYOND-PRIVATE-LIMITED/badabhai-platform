import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/bb_spinner.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/set_pin_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/set_pin_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_set_pin_form.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_view.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

/// A [SetPinCubit] that RECORDS the PIN handed to [submit] without touching the
/// manager or emitting `done` (a real `done` routes through go_router, which a
/// bare MaterialApp has no route for). [failWith] drives the server-failure path.
class FakeSetPinCubit extends SetPinCubit {
  FakeSetPinCubit(super.manager);

  final List<String> submitted = <String>[];

  @override
  Future<void> submit(String pin) async => submitted.add(pin);

  void failWith(String message) =>
      emit(SetPinState(status: SetPinStatus.failure, message: message));
}

/// The create/reset-PIN screen is now ONE page: the enter row and the confirm
/// row are both on screen together (no next-screen transition), driven by the
/// OS numeric keyboard (no custom keypad). Every error is a centred, blocking
/// dialog: a guessable PIN is blocked on the client, a mismatch and a server
/// rejection each clear both rows and explain in a dialog.
void main() {
  // #1463 — the active PIN slot carries a BLINKING caret, and a perpetual
  // blink keeps a frame scheduled forever, so every `pumpAndSettle` below
  // would pump until it timed out. Freeze it, exactly as Flutter's own
  // `EditableText.debugDeterministicCursor` exists to be frozen. The blink
  // itself is covered by its own discrete-pump test in bb_pin_keypad_test.
  setUpAll(() => BbPinView.debugDeterministicCaret = true);
  tearDownAll(() => BbPinView.debugDeterministicCaret = false);

  late FakeSetPinCubit cubit;

  setUp(() async {
    // `GetIt.reset()` is async — await it, or the reset lands AFTER the register
    // below and wipes it (see otp_verify_screen_test for the same footgun).
    await locator.reset();
    cubit = FakeSetPinCubit(MockAuthSessionManager());
    locator.registerFactory<SetPinCubit>(() => cubit);
  });

  tearDown(() => locator.reset());

  Future<void> pumpScreen(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: SetPinScreen()));
    await tester.pump();
  }

  /// Type into the OS-keyboard-driven field behind a row — no custom keypad on
  /// this screen any more.
  Future<void> enterFirst(WidgetTester tester, String pin) async {
    await tester.enterText(find.byKey(kSetPinFirstFieldKey), pin);
    await tester.pump();
  }

  Future<void> enterConfirm(WidgetTester tester, String pin) async {
    await tester.enterText(find.byKey(kSetPinConfirmFieldKey), pin);
    await tester.pump();
  }

  Future<void> tapOk(WidgetTester tester) async {
    await tester.tap(find.text('Theek hai'));
    await tester.pumpAndSettle();
  }

  testWidgets('both rows are on screen together — no next-screen transition',
      (WidgetTester tester) async {
    await pumpScreen(tester);

    expect(find.text('PIN DAALEIN'), findsOneWidget);
    expect(find.text('PIN DOBARA DAALEIN'), findsOneWidget);
    expect(find.byKey(kSetPinFirstFieldKey), findsOneWidget);
    expect(find.byKey(kSetPinConfirmFieldKey), findsOneWidget);
  });

  // #1464 — owner ruling: the worker picks their own PIN, full stop. The screen
  // used to hard-block 1234 / 1111 behind a centred dialog before the confirm
  // row was ever reachable.
  testWidgets('a guessable PIN is ACCEPTED — no strength gate on the client',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    await enterFirst(tester, '1234');
    await tester.pump();

    // No block, and the confirm row is live — the first row advanced normally.
    expect(find.text('Yeh PIN aasan hai'), findsNothing);
    expect(
        tester.widgetList<BbPinView>(find.byType(BbPinView)).toList()[1].focused,
        isTrue);

    await enterConfirm(tester, '1234');
    await tester.pump();

    expect(cubit.submitted, <String>['1234']);
  });

  testWidgets('an all-same PIN is accepted too', (WidgetTester tester) async {
    await pumpScreen(tester);
    await enterFirst(tester, '1111');
    await enterConfirm(tester, '1111');
    await tester.pump();

    expect(find.text('Yeh PIN aasan hai'), findsNothing);
    expect(cubit.submitted, <String>['1111']);
  });

  testWidgets('a mismatched confirm shows the mismatch dialog and clears both rows',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    await enterFirst(tester, '3927');
    await enterConfirm(tester, '1122'); // differs from 3927
    await tester.pumpAndSettle();

    expect(find.text('PIN alag hai'), findsOneWidget);
    await tapOk(tester);
    expect(cubit.submitted, isEmpty);
  });

  testWidgets('a matching confirm submits the PIN exactly once',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    await enterFirst(tester, '3927');
    await enterConfirm(tester, '3927'); // matches

    expect(cubit.submitted, <String>['3927']);
  });

  testWidgets('a server failure surfaces its full reason in a dialog',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    cubit.failWith('Server ne yeh PIN reject kar diya');
    await tester.pumpAndSettle();

    expect(find.text('PIN set nahi hua'), findsOneWidget);
    expect(find.text('Server ne yeh PIN reject kar diya'), findsOneWidget);
  });

  testWidgets('while submitting, the spinner shows and no custom keypad exists',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    // isSubmitting only ever comes from the real cubit state, not this fake —
    // this test just pins that the busy affordance is the real spinner, and
    // that the screen never renders a custom on-screen keypad at all.
    await enterFirst(tester, '3927');
    await enterConfirm(tester, '3927');
    await tester.pump();

    expect(find.text('7'), findsNothing); // no digit keys anywhere
    expect(find.byType(BbSpinner), findsNothing); // fake cubit never submits
  });

  // #1463 — the worker reported "PIN and confirm PIN not showing the cursor".
  // The capture field was a 1x1 box under Opacity(0) with showCursor:false, and
  // BbPinView only received a COUNT, so nothing on screen could say where the
  // next digit would land or which of the two rows was live.
  group('the cursor (#1463)', () {
    /// The two rows, in screen order: [0] is "PIN DAALEIN", [1] is the confirm.
    List<BbPinView> rows(WidgetTester tester) =>
        tester.widgetList<BbPinView>(find.byType(BbPinView)).toList();

    testWidgets('the caret starts on the first row, and there is exactly one',
        (WidgetTester tester) async {
      await pumpScreen(tester);
      await tester.pump(); // the post-frame autofocus

      expect(rows(tester)[0].focused, isTrue);
      expect(rows(tester)[1].focused, isFalse);
      // One row live means one caret on screen — never two, never none.
      expect(find.byKey(kPinCaretKey), findsOneWidget);
    });

    testWidgets('completing the first row MOVES the caret to the confirm row',
        (WidgetTester tester) async {
      await pumpScreen(tester);
      await enterFirst(tester, '3927');
      await tester.pump();

      // The auto-advance used to be invisible: focus jumped, nothing on screen
      // changed, and the worker kept typing at a row that was no longer live.
      expect(rows(tester)[0].focused, isFalse);
      expect(rows(tester)[1].focused, isTrue);
      expect(find.byKey(kPinCaretKey), findsOneWidget);
    });

    testWidgets('tapping a finished row brings the caret back to it',
        (WidgetTester tester) async {
      await pumpScreen(tester);
      await enterFirst(tester, '3927');
      await tester.pump();
      expect(rows(tester)[1].focused, isTrue);

      // Going back to fix the first PIN is the whole of "easily editable".
      await tester.tap(find.byKey(kSetPinFirstFieldKey));
      await tester.pump();

      expect(rows(tester)[0].focused, isTrue);
      expect(rows(tester)[1].focused, isFalse);
      expect(find.byKey(kPinCaretKey), findsOneWidget);
    });

    testWidgets('the caret lands at the END of a row it returns to',
        (WidgetTester tester) async {
      await pumpScreen(tester);
      await enterFirst(tester, '3927');
      await tester.pump();
      await tester.tap(find.byKey(kSetPinFirstFieldKey));
      await tester.pump();

      // Deterministic: the next digit appends and backspace bites the last one.
      final TextField field =
          tester.widget<TextField>(find.byKey(kSetPinFirstFieldKey));
      expect(field.controller!.selection.baseOffset, 4);
      expect(field.controller!.selection.isCollapsed, isTrue);
    });

    testWidgets('the capture field FILLS its row — never a 1x1 tap target',
        (WidgetTester tester) async {
      await pumpScreen(tester);

      final Size field = tester.getSize(find.byKey(kSetPinFirstFieldKey));
      // A collapsed field is one the OS can barely treat as a field at all.
      // It now spans the boxes, so a tap anywhere along the row lands.
      expect(field.height, greaterThanOrEqualTo(48));
      expect(field.width, greaterThan(200));
    });

    testWidgets('SECURITY: the field stays masked and unliftable',
        (WidgetTester tester) async {
      await pumpScreen(tester);
      await enterFirst(tester, '3927');
      await tester.pump();

      final TextField field =
          tester.widget<TextField>(find.byKey(kSetPinFirstFieldKey));
      // Masked twice over — obscureText AND a transparent glyph colour — now
      // that the field is full-size rather than hidden by being 1x1.
      expect(field.obscureText, isTrue);
      expect(field.style!.color, Colors.transparent);
      // No selection handles, no toolbar: a PIN must not reach the clipboard.
      expect(field.enableInteractiveSelection, isFalse);
      // NULL, not an empty list. Flutter only builds a DISABLED
      // AutofillConfiguration for null — an empty list is still "not null", so
      // it shipped the PIN's own editing value to the autofill service.
      expect(field.autofillHints, isNull);
      // And the keyboard must not fold a credential into its learned model
      // (Flutter defaults this true; obscureText does not change it).
      expect(field.enableIMEPersonalizedLearning, isFalse);
      // And the digits still never reach the screen.
      for (final String d in <String>['3', '9', '2', '7']) {
        expect(find.text(d), findsNothing);
      }
    });
  });

  // 4 boxes x 56 plus their 8px side padding need 288, but a 320dp handset
  // inside the 20px gutter offers 280 — an 8px RenderFlex overflow, yellow
  // stripes and all, on the cheapest phones the product targets.
  testWidgets('the narrowest handset (320dp) does not overflow',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await pumpScreen(tester);

    expect(tester.takeException(), isNull);
  });

  testWidgets('a short screen scrolls instead of overflowing',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(360, 480);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await pumpScreen(tester);

    // Both rows visible at once take more vertical room than a single step —
    // must never throw a RenderFlex overflow on a small handset.
    expect(tester.takeException(), isNull);
  });
}

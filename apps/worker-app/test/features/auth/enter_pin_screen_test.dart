import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/bb_spinner.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/enter_pin_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/enter_pin_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_keypad.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_view.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

/// The UNLOCK screen (shown on restart). Owner report: after the 4th digit the
/// dots filled then INSTANTLY blanked while the ~2s verify ran, which read like a
/// reset / wrong PIN and made workers re-enter a correct PIN. The dots must STAY
/// filled through the verify, with a loader in place of the keypad; they clear
/// ONLY on a wrong PIN, after the worker acknowledges it.
void main() {
  // #1466 — the unlock row now carries a BLINKING caret, and a perpetual blink
  // keeps a frame scheduled forever, so every `pumpAndSettle` below would pump
  // until it timed out. Freeze it, exactly as Flutter's own
  // `EditableText.debugDeterministicCursor` exists to be frozen.
  setUpAll(() => BbPinView.debugDeterministicCaret = true);
  tearDownAll(() => BbPinView.debugDeterministicCaret = false);

  late MockAuthSessionManager manager;

  setUp(() async {
    await locator.reset();
    manager = MockAuthSessionManager();
    locator.registerFactory<EnterPinCubit>(() => EnterPinCubit(manager));
  });

  tearDown(() => locator.reset());

  Future<void> pumpScreen(WidgetTester tester) async {
    tester.view.physicalSize = const Size(400, 820);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(const MaterialApp(home: EnterPinScreen()));
    await tester.pumpAndSettle();
  }

  Future<void> enterPin(WidgetTester tester, String pin) async {
    for (final String d in pin.split('')) {
      await tester.tap(find.descendant(
        of: find.byType(BbPinKeypad),
        matching: find.text(d),
      ));
      await tester.pump();
    }
  }

  int filledDots(WidgetTester tester) =>
      tester.widget<BbPinView>(find.byType(BbPinView)).filled;

  // #1466 — "every screen or flow that has the PIN view must show the cursor
  // and must be easy to edit if the wrong PIN is put in".
  group('the cursor, and fixing a typo (#1466)', () {
    Future<void> tapBackspace(WidgetTester tester) async {
      await tester.tap(find.bySemanticsLabel(kBackspaceSemanticLabel));
      await tester.pump();
    }

    testWidgets('the row shows a caret on the slot the next digit lands in',
        (WidgetTester tester) async {
      await pumpScreen(tester);

      expect(tester.widget<BbPinView>(find.byType(BbPinView)).focused, isTrue);
      expect(find.byKey(kPinCaretKey), findsOneWidget);

      await enterPin(tester, '39');
      expect(filledDots(tester), 2);
      // Still exactly one caret — it has moved with the worker, not multiplied.
      expect(find.byKey(kPinCaretKey), findsOneWidget);
    });

    testWidgets('the caret goes away while the PIN is actually verifying',
        (WidgetTester tester) async {
      final Completer<void> verifying = Completer<void>();
      when(() => manager.unlockWithPin(any()))
          .thenAnswer((_) => verifying.future);
      await pumpScreen(tester);

      await enterPin(tester, '3927');
      await tester.pump(BbPinView.fillPopSettle);
      await tester.pump();

      // Nothing can be typed during the verify, so nothing claims to be live.
      expect(tester.widget<BbPinView>(find.byType(BbPinView)).focused, isFalse);
      expect(find.byKey(kPinCaretKey), findsNothing);
      verifying.complete();
      await tester.pumpAndSettle();
    });

    // THE typo case. A mistyped LAST digit used to be unfixable: input froze
    // for the fill-pop and the PIN submitted itself 300ms later, spending one
    // of the five attempts before lockout on a mistake the worker had already
    // spotted.
    testWidgets('backspacing the 4th digit CANCELS the submit — no attempt is '
        'spent on a typo', (WidgetTester tester) async {
      when(() => manager.unlockWithPin(any())).thenAnswer((_) async {});
      await pumpScreen(tester);

      await enterPin(tester, '3928'); // last digit wrong
      await tapBackspace(tester); // caught it, mid pop-beat

      expect(filledDots(tester), 3);
      // Let the cancelled submit's delay elapse in full.
      await tester.pump(BbPinView.fillPopSettle);
      await tester.pump();
      verifyNever(() => manager.unlockWithPin(any()));

      // And the corrected PIN still submits normally.
      await enterPin(tester, '7');
      await tester.pump(BbPinView.fillPopSettle);
      await tester.pump();
      verify(() => manager.unlockWithPin('3927')).called(1);
    });

    testWidgets('backspace works at every point, not only below 4 digits',
        (WidgetTester tester) async {
      when(() => manager.unlockWithPin(any())).thenAnswer((_) async {});
      await pumpScreen(tester);

      await enterPin(tester, '3927');
      for (int i = 3; i >= 0; i--) {
        await tapBackspace(tester);
        expect(filledDots(tester), i);
      }
      await tester.pump(BbPinView.fillPopSettle);
      await tester.pump();
      verifyNever(() => manager.unlockWithPin(any()));
      // An empty row cannot go negative.
      await tapBackspace(tester);
      expect(filledDots(tester), 0);
      expect(tester.takeException(), isNull);
    });
  });

  testWidgets(
      'while the PIN verifies the dots STAY filled and a loader replaces the '
      'keypad — never a mid-verify blank', (WidgetTester tester) async {
    // A verify still in flight (never completes during the assertions).
    final Completer<void> verifying = Completer<void>();
    when(() => manager.unlockWithPin(any()))
        .thenAnswer((_) => verifying.future);

    await pumpScreen(tester);
    await enterPin(tester, '3927');
    // Past the 4th-dot pop beat → the unlock is now in flight (submitting).
    await tester.pump(const Duration(milliseconds: 400));

    expect(filledDots(tester), 4,
        reason: 'the dots must not blank while the PIN is verifying');
    expect(find.byType(BbSpinner), findsOneWidget);
    expect(find.byType(BbPinKeypad), findsNothing);

    verifying.complete(); // let it settle so no timer/future outlives the test
    await tester.pumpAndSettle();
  });

  testWidgets(
      'a wrong PIN shows the dialog with the dots still filled, and clears them '
      'ONLY after the worker acknowledges', (WidgetTester tester) async {
    when(() => manager.unlockWithPin(any())).thenThrow(
        const AuthFailure(AuthErrorCode.pinVerifyFailed, statusCode: 401));

    await pumpScreen(tester);
    await enterPin(tester, '3927');
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();

    // Error surfaced in the centred dialog; the dots have NOT blanked yet.
    expect(find.text('PIN sahi nahi'), findsOneWidget);
    expect(filledDots(tester), 4);

    await tester.tap(find.text('Theek hai'));
    await tester.pumpAndSettle();

    // Now — and only now — the dots reset for a fresh retry.
    expect(filledDots(tester), 0);
    expect(find.byType(BbPinKeypad), findsOneWidget);
  });
}

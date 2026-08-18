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

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/set_pin_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/set_pin_screen.dart';

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

/// The create/reset-PIN screen now drives EVERY error through a centred,
/// blocking dialog and BLOCKS a guessable PIN on the client — replacing the tiny
/// inline red text a first-time, low-literacy worker missed. These tests pin
/// that behaviour: the guessable block, the mismatch dialog, the server-failure
/// dialog, the happy path, and no overflow on a short screen.
void main() {
  // The exact copy the screen ships — asserted verbatim so a wording drift is
  // caught here rather than by a worker.
  const String guessMsg =
      '1234 ya 1111 jaisa PIN koi bhi aasani se guess kar sakta hai. '
      'Aisa 4-digit PIN chunein jo sirf aap jaante hain.';

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

  /// Tap the on-screen keypad digit by digit (no OS keyboard on this surface).
  Future<void> enterPin(WidgetTester tester, String pin) async {
    for (final String d in pin.split('')) {
      await tester.tap(find.text(d));
      await tester.pump();
    }
  }

  testWidgets('a guessable PIN is blocked with a dialog and never advances',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    await enterPin(tester, '1234');
    await tester.pumpAndSettle();

    // The centred block — not a silent advance to confirm.
    expect(find.text('Yeh PIN aasan hai'), findsOneWidget);
    expect(find.text(guessMsg), findsOneWidget);

    await tester.tap(find.text('Theek hai'));
    await tester.pumpAndSettle();

    // Still on the ENTER step: the enter title is present, the confirm one is not.
    expect(find.text('PIN banayein'), findsOneWidget);
    expect(find.text('PIN dobara daalein'), findsNothing);
    // A hard client block never reaches the cubit.
    expect(cubit.submitted, isEmpty);
  });

  testWidgets('a strong PIN advances to the confirm step',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    await enterPin(tester, '3927');
    await tester.pumpAndSettle();

    expect(find.text('PIN dobara daalein'), findsOneWidget);
    expect(cubit.submitted, isEmpty);
  });

  testWidgets('a mismatched confirm shows the mismatch dialog, back to enter',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    await enterPin(tester, '3927'); // -> confirm
    await tester.pumpAndSettle();
    expect(find.text('PIN dobara daalein'), findsOneWidget);

    await enterPin(tester, '1122'); // differs from 3927
    await tester.pumpAndSettle();
    expect(find.text('PIN alag hai'), findsOneWidget);

    await tester.tap(find.text('Theek hai'));
    await tester.pumpAndSettle();
    expect(find.text('PIN banayein'), findsOneWidget); // back to enter
    expect(cubit.submitted, isEmpty);
  });

  testWidgets('a matching confirm submits the PIN exactly once',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    await enterPin(tester, '3927'); // -> confirm
    await tester.pumpAndSettle();
    await enterPin(tester, '3927'); // matches
    await tester.pump();

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

  testWidgets('a short screen scrolls instead of overflowing',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(360, 480);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await pumpScreen(tester);

    // The keypad body centres when there is room and scrolls when cramped — it
    // must never throw a RenderFlex overflow on a small handset.
    expect(tester.takeException(), isNull);
  });
}

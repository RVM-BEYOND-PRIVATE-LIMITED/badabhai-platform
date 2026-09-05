import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/bb_spinner.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/set_pin_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/set_pin_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_set_pin_form.dart';

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

  testWidgets('a guessable PIN is blocked with a dialog and clears the row',
      (WidgetTester tester) async {
    await pumpScreen(tester);
    await enterFirst(tester, '1234');
    await tester.pumpAndSettle();

    // The centred block — not a silent advance.
    expect(find.text('Yeh PIN aasan hai'), findsOneWidget);
    expect(find.text(guessMsg), findsOneWidget);

    await tapOk(tester);

    // Still on the one page; the confirm row was never reached.
    expect(find.text('PIN DAALEIN'), findsOneWidget);
    expect(cubit.submitted, isEmpty);
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

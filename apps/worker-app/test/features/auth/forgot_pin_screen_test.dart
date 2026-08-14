import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/forgot_pin_screen.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

/// The PIN-RESET flow now BLOCKS a guessable new PIN CLIENT-SIDE, before the
/// worker's one-time reset OTP is ever spent, and shows the same centred dialog
/// as the set-PIN screen for a weak PIN or a confirm mismatch. This pins that a
/// guessable PIN in the pin phase raises the block and never advances to the OTP
/// (confirm) phase, so `confirmPinReset` is never called.
void main() {
  const String guessMsg =
      '1234 ya 1111 jaisa PIN koi bhi aasani se guess kar sakta hai. '
      'Aisa 4-digit PIN chunein jo sirf aap jaante hain.';

  late MockAuthSessionManager manager;

  setUp(() async {
    await locator.reset();
    manager = MockAuthSessionManager();
    // requestPinReset SUCCEEDS so the phone step advances into the pin phase.
    // SmsOtpAutofill is deliberately NOT registered — the screen's initState
    // skips the auto-read wiring and stays usable by typing.
    when(() => manager.requestPinReset(any())).thenAnswer((_) async {});
    locator.registerSingleton<AuthSessionManager>(manager);
  });

  tearDown(() => locator.reset());

  /// Pump the screen and walk it from the phone step into the PIN phase.
  Future<void> pumpToPinPhase(WidgetTester tester) async {
    await tester.pumpWidget(const MaterialApp(home: ForgotPinScreen()));
    await tester.pump();
    await tester.enterText(find.byType(TextField), '9876543210');
    await tester.pump(); // repaint the CTA at 10 digits
    await tester.tap(find.text('Send OTP'));
    await tester.pumpAndSettle();
  }

  Future<void> enterPin(WidgetTester tester, String pin) async {
    for (final String d in pin.split('')) {
      await tester.tap(find.text(d));
      await tester.pump();
    }
  }

  testWidgets('a guessable new PIN is blocked before the OTP phase',
      (WidgetTester tester) async {
    await pumpToPinPhase(tester);
    expect(find.text('Naya 4-digit PIN banayein'), findsOneWidget);

    await enterPin(tester, '1234');
    await tester.pumpAndSettle();

    // Blocked with the centred dialog, not silently advanced.
    expect(find.text('Yeh PIN aasan hai'), findsOneWidget);
    expect(find.text(guessMsg), findsOneWidget);

    await tester.tap(find.text('Theek hai'));
    await tester.pumpAndSettle();

    // Still on the PIN-enter step; the OTP (confirm) phase was never reached...
    expect(find.text('Naya 4-digit PIN banayein'), findsOneWidget);
    expect(find.text('OTP daalein'), findsNothing);
    // ...so the worker's reset OTP was never spent on a confirm.
    verifyNever(() => manager.confirmPinReset(any(), any(), any()));
  });

  testWidgets('a mismatched confirm shows the dialog and stays in the pin phase',
      (WidgetTester tester) async {
    await pumpToPinPhase(tester);

    await enterPin(tester, '3927'); // strong -> confirm step
    await tester.pumpAndSettle();
    expect(find.text('PIN dobara daalein'), findsOneWidget);

    await enterPin(tester, '1122'); // differs from 3927
    await tester.pumpAndSettle();
    expect(find.text('PIN alag hai'), findsOneWidget);

    await tester.tap(find.text('Theek hai'));
    await tester.pumpAndSettle();
    expect(find.text('Naya 4-digit PIN banayein'), findsOneWidget); // re-enter
    expect(find.text('OTP daalein'), findsNothing);
    verifyNever(() => manager.confirmPinReset(any(), any(), any()));
  });
}

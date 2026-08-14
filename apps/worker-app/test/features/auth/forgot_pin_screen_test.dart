import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/forgot_pin_screen.dart';
import 'package:badabhai_worker_app/router.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

/// The PIN-RESET flow asks for the OTP BEFORE the new PIN: phone → OTP → new
/// PIN. The OTP is verified with the new PIN at the single `confirmPinReset`
/// call (there is no standalone reset-OTP verify), so a matching PIN is what
/// submits. A guessable PIN is still blocked client-side before that call, and a
/// weak PIN / confirm mismatch each raise the centred dialog.
void main() {
  const String guessMsg =
      '1234 ya 1111 jaisa PIN koi bhi aasani se guess kar sakta hai. '
      'Aisa 4-digit PIN chunein jo sirf aap jaante hain.';

  late MockAuthSessionManager manager;

  setUp(() async {
    await locator.reset();
    manager = MockAuthSessionManager();
    // requestPinReset SUCCEEDS so the phone step advances into the OTP phase.
    // SmsOtpAutofill is deliberately NOT registered — the screen's initState
    // skips the auto-read wiring and stays usable by typing.
    when(() => manager.requestPinReset(any())).thenAnswer((_) async {});
    locator.registerSingleton<AuthSessionManager>(manager);
  });

  tearDown(() => locator.reset());

  /// A router so the success path's `context.go(Routes.pin)` resolves.
  Widget app() {
    final GoRouter router = GoRouter(
      routes: <RouteBase>[
        GoRoute(path: '/', builder: (_, __) => const ForgotPinScreen()),
        GoRoute(
          path: Routes.pin,
          builder: (_, __) => const Scaffold(body: Text('PIN STUB')),
        ),
      ],
    );
    return MaterialApp.router(routerConfig: router);
  }

  /// Phone step → send OTP → land on the OTP phase.
  Future<void> pumpToOtpPhase(WidgetTester tester) async {
    await tester.pumpWidget(app());
    await tester.pump();
    await tester.enterText(find.byType(TextField), '9876543210');
    await tester.pump(); // repaint the CTA at 10 digits
    await tester.tap(find.text('Send OTP'));
    await tester.pumpAndSettle();
  }

  /// …then enter the OTP and continue into the PIN phase.
  Future<void> pumpToPinPhase(WidgetTester tester) async {
    await pumpToOtpPhase(tester);
    await tester.enterText(find.byType(TextField), '123456');
    await tester.pump();
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();
  }

  Future<void> enterPin(WidgetTester tester, String pin) async {
    for (final String d in pin.split('')) {
      await tester.tap(find.text(d));
      await tester.pump();
    }
  }

  testWidgets('flow order: phone → OTP → new PIN (OTP comes BEFORE the PIN)',
      (WidgetTester tester) async {
    await pumpToOtpPhase(tester);

    // After Send OTP we are on the OTP step — NOT the PIN step.
    expect(find.text('OTP daalein'), findsOneWidget); // header
    expect(find.text('OTP DAALEIN'), findsOneWidget); // eyebrow
    expect(find.text('Aage badhein'), findsOneWidget);
    expect(find.text('Naya 4-digit PIN banayein'), findsNothing);

    // Enter the code and continue → now the new-PIN step.
    await tester.enterText(find.byType(TextField), '123456');
    await tester.pump();
    await tester.tap(find.text('Aage badhein'));
    await tester.pumpAndSettle();

    expect(find.text('Naya 4-digit PIN banayein'), findsOneWidget);
    // Nothing is submitted just by reaching the PIN step.
    verifyNever(() => manager.confirmPinReset(any(), any(), any()));
  });

  testWidgets('a matching new PIN submits {phone, otp, pin} exactly once',
      (WidgetTester tester) async {
    when(() => manager.confirmPinReset(any(), any(), any()))
        .thenAnswer((_) async {});

    await pumpToPinPhase(tester);
    await enterPin(tester, '3927'); // strong → confirm step
    await tester.pumpAndSettle();
    await enterPin(tester, '3927'); // matches → submit
    await tester.pumpAndSettle();

    // The OTP entered in the OTP phase rides the confirm with the new PIN.
    verify(() => manager.confirmPinReset(any(), '123456', '3927')).called(1);
    expect(find.text('PIN STUB'), findsOneWidget); // routed on success
  });

  testWidgets('a guessable new PIN is blocked before the confirm call',
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

    // Still on the PIN-enter step; the reset OTP was never spent on a confirm.
    expect(find.text('Naya 4-digit PIN banayein'), findsOneWidget);
    verifyNever(() => manager.confirmPinReset(any(), any(), any()));
  });

  testWidgets('a mismatched confirm shows the dialog and stays in the pin phase',
      (WidgetTester tester) async {
    await pumpToPinPhase(tester);

    await enterPin(tester, '3927'); // strong → confirm step
    await tester.pumpAndSettle();
    expect(find.text('PIN dobara daalein'), findsOneWidget);

    await enterPin(tester, '1122'); // differs from 3927
    await tester.pumpAndSettle();
    expect(find.text('PIN alag hai'), findsOneWidget);

    await tester.tap(find.text('Theek hai'));
    await tester.pumpAndSettle();
    expect(find.text('Naya 4-digit PIN banayein'), findsOneWidget); // re-enter
    verifyNever(() => manager.confirmPinReset(any(), any(), any()));
  });

  testWidgets('a failed send-OTP is a dialog, and stays on the phone step',
      (WidgetTester tester) async {
    when(() => manager.requestPinReset(any()))
        .thenThrow(const AuthFailure(AuthErrorCode.otpRateLimited));

    await tester.pumpWidget(app());
    await tester.pump();
    await tester.enterText(find.byType(TextField), '9876543210');
    await tester.pump();
    await tester.tap(find.text('Send OTP'));
    await tester.pumpAndSettle();

    expect(find.text('OTP nahi bhej paye'), findsOneWidget); // dialog, not inline
    await tester.tap(find.text('Theek hai'));
    await tester.pumpAndSettle();
    // Still on the phone step (never advanced to OTP).
    expect(find.text('MOBILE NUMBER'), findsOneWidget);
    expect(find.text('OTP DAALEIN'), findsNothing);
  });

  testWidgets('a bad OTP at confirm is a dialog and returns to the OTP step',
      (WidgetTester tester) async {
    when(() => manager.confirmPinReset(any(), any(), any()))
        .thenThrow(const AuthFailure(AuthErrorCode.otpInvalid));

    await pumpToPinPhase(tester);
    await enterPin(tester, '3927'); // strong → confirm step
    await tester.pumpAndSettle();
    await enterPin(tester, '3927'); // matches → submit → throws otpInvalid
    await tester.pumpAndSettle();

    expect(find.text('OTP sahi nahi'), findsOneWidget); // dialog
    await tester.tap(find.text('Theek hai'));
    await tester.pumpAndSettle();
    // Back on the OTP step to fix the code (new PIN not lost to a bad code).
    expect(find.text('OTP daalein'), findsOneWidget);
    expect(find.text('Aage badhein'), findsOneWidget);
  });
}

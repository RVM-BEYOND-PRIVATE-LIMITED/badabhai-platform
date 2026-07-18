import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/auth/phone_format.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/phone_login_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/forgot_pin_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/phone_login_screen.dart';

class _MockManager extends Mock implements AuthSessionManager {}

/// T1 — `+91` used to be seeded INTO the controller, so the worker could
/// backspace it away, and the raw field text went to requestOtp() verbatim: a
/// number that had lost its `+91` was sent malformed and the OTP never arrived.
/// It is now fixed chrome the field renders; the controller holds 10 digits.
void main() {
  late _MockManager manager;

  setUp(() async {
    await locator.reset();
    manager = _MockManager();
    // Fails on purpose: a SUCCESSFUL request pushes /otp, which needs a
    // GoRouter these tests deliberately do not build — they are about what goes
    // ON THE WIRE, not navigation. The call is still captured either way.
    when(() => manager.requestOtp(any()))
        .thenThrow(const AuthFailure(AuthErrorCode.network));
    when(() => manager.requestPinReset(any())).thenAnswer((_) async {});
    locator.registerSingleton<AuthSessionManager>(manager);
    locator.registerFactory<PhoneLoginCubit>(
        () => PhoneLoginCubit(manager, locale: 'en'));
  });

  tearDown(() async => locator.reset());

  group('toE164 / isCompleteNationalNumber', () {
    test('composes E.164 from the national digits', () {
      expect(toE164('9876543210'), '+919876543210');
    });

    test('strips anything non-digit defensively', () {
      expect(toE164('98765 43210'), '+919876543210');
      // NOTE it strips but does NOT cap — a pasted country code would double up.
      // That is unreachable through the UI (the field is digits-only, max 10) and
      // capping here would silently truncate a caller's number instead of
      // failing loudly, so composition stays dumb and the field stays the gate.
      expect(toE164('+91 98765-43210'), '+91919876543210');
    });

    test('completeness is exactly 10 digits', () {
      expect(isCompleteNationalNumber('987654321'), isFalse);
      expect(isCompleteNationalNumber('9876543210'), isTrue);
      // Deliberately does NOT police the leading digit or operator range — the
      // server is the authority, and a client guess would lock out a worker
      // whose number series the app has never heard of.
      expect(isCompleteNationalNumber('0000000000'), isTrue);
    });
  });

  group('phone login', () {
    testWidgets('+91 is chrome and cannot be typed away', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(const MaterialApp(home: PhoneLoginScreen()));

      // Rendered by the field, not held in the controller.
      expect(find.text('+91 '), findsOneWidget);

      // A worker mashing backspace on an empty field cannot remove it.
      await tester.enterText(find.byType(TextField), '');
      await tester.pump();
      expect(find.text('+91 '), findsOneWidget);
    });

    testWidgets('accepts digits only, capped at 10', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(const MaterialApp(home: PhoneLoginScreen()));

      // Letters, punctuation, a pasted country code and overflow digits.
      await tester.enterText(find.byType(TextField), '+91 98a7b6-5432 10999');
      await tester.pump();

      final TextField field = tester.widget<TextField>(find.byType(TextField));
      expect(field.controller!.text, '9198765432',
          reason: 'digitsOnly then capped at 10 — no code, spaces or letters');
      expect(field.controller!.text.length, kNationalNumberDigits);
    });

    testWidgets('the CTA is disabled until 10 digits', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(const MaterialApp(home: PhoneLoginScreen()));

      await tester.enterText(find.byType(TextField), '98765');
      await tester.pump();
      await tester.tap(find.text('Send OTP'));
      await tester.pump();
      verifyNever(() => manager.requestOtp(any()));

      await tester.enterText(find.byType(TextField), '9876543210');
      await tester.pump();
      await tester.tap(find.text('Send OTP'));
      await tester.pump();
      verify(() => manager.requestOtp(any())).called(1);
    });

    testWidgets('submits E.164 — +91 prepended exactly once', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(const MaterialApp(home: PhoneLoginScreen()));
      await tester.enterText(find.byType(TextField), '9876543210');
      await tester.pump();
      await tester.tap(find.text('Send OTP'));
      await tester.pump();

      final List<String> sent = verify(() => manager.requestOtp(captureAny()))
          .captured
          .cast<String>();
      expect(sent.single, '+919876543210');
    });
  });

  group('forgot PIN (same bug, same fix)', () {
    testWidgets('+91 is chrome and the CTA gates on 10 digits', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(const MaterialApp(home: ForgotPinScreen()));

      expect(find.text('+91 '), findsOneWidget);

      await tester.enterText(find.byType(TextField).first, '98765');
      await tester.pump();
      await tester.tap(find.text('Send OTP'));
      await tester.pump();
      verifyNever(() => manager.requestPinReset(any()));
    });

    testWidgets('sends E.164 to the reset request', (
      WidgetTester tester,
    ) async {
      await tester.pumpWidget(const MaterialApp(home: ForgotPinScreen()));

      await tester.enterText(find.byType(TextField).first, '9876543210');
      await tester.pump();
      await tester.tap(find.text('Send OTP'));
      await tester.pump();

      final List<String> sent =
          verify(() => manager.requestPinReset(captureAny()))
              .captured
              .cast<String>();
      expect(sent.single, '+919876543210');
    });
  });
}

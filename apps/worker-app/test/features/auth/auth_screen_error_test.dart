import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/otp_verify_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/phone_login_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/otp_verify_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/phone_login_screen.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

void main() {
  late MockAuthSessionManager manager;

  setUp(() {
    manager = MockAuthSessionManager();
    // Swap the real graph for the cubits backed by a manager we control. Force
    // the English locale so the asserted copy is deterministic.
    locator.reset();
    locator.registerFactory<PhoneLoginCubit>(
        () => PhoneLoginCubit(manager, locale: 'en'));
    locator.registerFactory<OtpVerifyCubit>(
        () => OtpVerifyCubit(manager, locale: 'en'));
  });

  tearDown(() => locator.reset());

  testWidgets(
    'phone-login: a failed OTP request surfaces the error in a SnackBar',
    (WidgetTester tester) async {
      when(() => manager.requestOtp(any()))
          .thenThrow(const AuthFailure(AuthErrorCode.network));

      await tester.pumpWidget(const MaterialApp(home: PhoneLoginScreen()));
      await tester.tap(find.text('Send OTP'));
      await tester.pump(); // submitting
      await tester.pump(); // failure -> listener fires the SnackBar

      expect(
        find.text('Can\'t reach the server. Please try again.'),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'otp-verify: a failed verify surfaces the error in a SnackBar',
    (WidgetTester tester) async {
      when(() => manager.verifyOtp(any(), any()))
          .thenThrow(const AuthFailure(AuthErrorCode.unknown));

      await tester.pumpWidget(const MaterialApp(home: OtpVerifyScreen()));
      await tester.tap(find.text('Verify'));
      await tester.pump(); // submitting
      await tester.pump(); // failure -> listener fires the SnackBar

      expect(
        find.text('Something went wrong. Please try again.'),
        findsOneWidget,
      );
    },
  );
}

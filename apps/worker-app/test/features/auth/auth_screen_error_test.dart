import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_repository.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/otp_verify_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/phone_login_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/otp_verify_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/phone_login_screen.dart';

class MockAuthRepository extends Mock implements AuthRepository {}

void main() {
  late MockAuthRepository repo;

  setUp(() {
    repo = MockAuthRepository();
    // Swap the real graph for the cubits backed by a mock repo we control.
    locator.reset();
    locator.registerFactory<PhoneLoginCubit>(() => PhoneLoginCubit(repo));
    locator.registerFactory<OtpVerifyCubit>(() => OtpVerifyCubit(repo));
  });

  tearDown(() => locator.reset());

  testWidgets(
    'phone-login: a failed OTP request surfaces the error in a SnackBar',
    (WidgetTester tester) async {
      when(() => repo.requestOtp(any())).thenThrow(const NetworkFailure());

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
      when(() => repo.verifyOtp(
            phoneE164: any(named: 'phoneE164'),
            otp: any(named: 'otp'),
          )).thenThrow(const ServerFailure(500));

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

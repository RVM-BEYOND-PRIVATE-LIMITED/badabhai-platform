import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/phone_login_cubit.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

void main() {
  late MockAuthSessionManager manager;
  setUp(() => manager = MockAuthSessionManager());

  blocTest<PhoneLoginCubit, PhoneLoginState>(
    'submit -> submitting then success, requesting the OTP',
    build: () {
      when(() => manager.requestOtp(any())).thenAnswer(
        (_) async => const OtpRequestResult(resendIn: Duration(seconds: 30)),
      );
      return PhoneLoginCubit(manager);
    },
    act: (PhoneLoginCubit c) => c.submit('+919912345678'),
    expect: () => const <PhoneLoginState>[
      PhoneLoginState(
          status: PhoneLoginStatus.submitting, phone: '+919912345678'),
      PhoneLoginState(
          status: PhoneLoginStatus.success, phone: '+919912345678'),
    ],
    verify: (_) => verify(() => manager.requestOtp('+919912345678')).called(1),
  );

  blocTest<PhoneLoginCubit, PhoneLoginState>(
    'failure -> submitting then failure with localized AuthFailure copy',
    build: () {
      when(() => manager.requestOtp(any()))
          .thenThrow(const AuthFailure(AuthErrorCode.network));
      return PhoneLoginCubit(manager, locale: 'en');
    },
    act: (PhoneLoginCubit c) => c.submit('+919912345678'),
    expect: () => const <PhoneLoginState>[
      PhoneLoginState(
          status: PhoneLoginStatus.submitting, phone: '+919912345678'),
      PhoneLoginState(
          status: PhoneLoginStatus.failure,
          phone: '+919912345678',
          message: "Can't reach the server. Please try again."),
    ],
  );

  // Re-entrancy guard: a double-tap while a request is in flight must not fire a
  // second OTP send (duplicate sends hit provider rate-limits and cost).
  blocTest<PhoneLoginCubit, PhoneLoginState>(
    'a double submit while in flight only requests the OTP once',
    build: () {
      when(() => manager.requestOtp(any())).thenAnswer(
        (_) async {
          await Future<void>.delayed(const Duration(milliseconds: 50));
          return const OtpRequestResult(resendIn: Duration(seconds: 30));
        },
      );
      return PhoneLoginCubit(manager);
    },
    act: (PhoneLoginCubit c) {
      c.submit('+919912345678'); // in flight
      c.submit('+919912345678'); // dropped by the guard
    },
    wait: const Duration(milliseconds: 80),
    expect: () => const <PhoneLoginState>[
      PhoneLoginState(
          status: PhoneLoginStatus.submitting, phone: '+919912345678'),
      PhoneLoginState(
          status: PhoneLoginStatus.success, phone: '+919912345678'),
    ],
    verify: (_) => verify(() => manager.requestOtp('+919912345678')).called(1),
  );
}

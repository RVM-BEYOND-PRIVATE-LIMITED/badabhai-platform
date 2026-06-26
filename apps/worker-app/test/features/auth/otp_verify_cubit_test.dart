import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_repository.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/otp_verify_cubit.dart';

class MockAuthRepository extends Mock implements AuthRepository {}

void main() {
  late MockAuthRepository repo;
  setUp(() => repo = MockAuthRepository());

  blocTest<OtpVerifyCubit, OtpVerifyState>(
    'verify -> submitting then success',
    build: () {
      when(() => repo.verifyOtp(
            phoneE164: any(named: 'phoneE164'),
            otp: any(named: 'otp'),
          )).thenAnswer((_) async {});
      return OtpVerifyCubit(repo);
    },
    act: (OtpVerifyCubit c) => c.verify(phone: '+919912345678', otp: '1234'),
    expect: () => const <OtpVerifyState>[
      OtpVerifyState(status: OtpVerifyStatus.submitting),
      OtpVerifyState(status: OtpVerifyStatus.success),
    ],
    verify: (_) => verify(
      () => repo.verifyOtp(phoneE164: '+919912345678', otp: '1234'),
    ).called(1),
  );

  blocTest<OtpVerifyCubit, OtpVerifyState>(
    'failure -> submitting then failure with a generic message',
    build: () {
      when(() => repo.verifyOtp(
            phoneE164: any(named: 'phoneE164'),
            otp: any(named: 'otp'),
          )).thenThrow(const ServerFailure(500));
      return OtpVerifyCubit(repo);
    },
    act: (OtpVerifyCubit c) => c.verify(phone: '+919912345678', otp: '1234'),
    expect: () => const <OtpVerifyState>[
      OtpVerifyState(status: OtpVerifyStatus.submitting),
      OtpVerifyState(
          status: OtpVerifyStatus.failure,
          message: 'Something went wrong. Please try again.'),
    ],
  );

  // Re-entrancy guard: a double-tap while a verify is in flight must not fire a
  // second verifyOtp (duplicate verifies are wasteful/confusing).
  blocTest<OtpVerifyCubit, OtpVerifyState>(
    'a double verify while in flight only calls the repo once',
    build: () {
      when(() => repo.verifyOtp(
            phoneE164: any(named: 'phoneE164'),
            otp: any(named: 'otp'),
          )).thenAnswer(
        (_) async =>
            Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      return OtpVerifyCubit(repo);
    },
    act: (OtpVerifyCubit c) {
      c.verify(phone: '+919912345678', otp: '1234'); // in flight
      c.verify(phone: '+919912345678', otp: '1234'); // dropped by the guard
    },
    wait: const Duration(milliseconds: 80),
    expect: () => const <OtpVerifyState>[
      OtpVerifyState(status: OtpVerifyStatus.submitting),
      OtpVerifyState(status: OtpVerifyStatus.success),
    ],
    verify: (_) => verify(
      () => repo.verifyOtp(phoneE164: '+919912345678', otp: '1234'),
    ).called(1),
  );
}

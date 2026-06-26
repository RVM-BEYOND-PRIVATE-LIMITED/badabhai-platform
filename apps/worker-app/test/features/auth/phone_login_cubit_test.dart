import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_repository.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/phone_login_cubit.dart';

class MockAuthRepository extends Mock implements AuthRepository {}

void main() {
  late MockAuthRepository repo;
  setUp(() => repo = MockAuthRepository());

  blocTest<PhoneLoginCubit, PhoneLoginState>(
    'submit -> submitting then success, requesting the OTP',
    build: () {
      when(() => repo.requestOtp(any())).thenAnswer((_) async {});
      return PhoneLoginCubit(repo);
    },
    act: (PhoneLoginCubit c) => c.submit('+919912345678'),
    expect: () => const <PhoneLoginState>[
      PhoneLoginState(
          status: PhoneLoginStatus.submitting, phone: '+919912345678'),
      PhoneLoginState(
          status: PhoneLoginStatus.success, phone: '+919912345678'),
    ],
    verify: (_) => verify(() => repo.requestOtp('+919912345678')).called(1),
  );

  blocTest<PhoneLoginCubit, PhoneLoginState>(
    'failure -> submitting then failure with a generic message',
    build: () {
      when(() => repo.requestOtp(any())).thenThrow(const NetworkFailure());
      return PhoneLoginCubit(repo);
    },
    act: (PhoneLoginCubit c) => c.submit('+919912345678'),
    expect: () => const <PhoneLoginState>[
      PhoneLoginState(
          status: PhoneLoginStatus.submitting, phone: '+919912345678'),
      PhoneLoginState(
          status: PhoneLoginStatus.failure,
          phone: '+919912345678',
          message: 'Can\'t reach the server. Please try again.'),
    ],
  );

  // Re-entrancy guard: a double-tap while a request is in flight must not fire a
  // second OTP send (duplicate sends hit provider rate-limits and cost).
  blocTest<PhoneLoginCubit, PhoneLoginState>(
    'a double submit while in flight only requests the OTP once',
    build: () {
      when(() => repo.requestOtp(any())).thenAnswer(
        (_) async =>
            Future<void>.delayed(const Duration(milliseconds: 50)),
      );
      return PhoneLoginCubit(repo);
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
    verify: (_) => verify(() => repo.requestOtp('+919912345678')).called(1),
  );
}

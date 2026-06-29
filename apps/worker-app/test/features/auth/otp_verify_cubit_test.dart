import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/otp_verify_cubit.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

OtpVerifyResult _result({required bool isNewUser, required bool pinSet}) =>
    OtpVerifyResult(
      workerId: 'w-1',
      isNewUser: isNewUser,
      pinSet: pinSet,
      tokens: AuthTokens(
        access: 'a',
        refresh: 'r',
        accessExpiresAt: DateTime(2030),
      ),
    );

void main() {
  late MockAuthSessionManager manager;
  setUp(() => manager = MockAuthSessionManager());

  blocTest<OtpVerifyCubit, OtpVerifyState>(
    'new user (no PIN) -> success routes to set-PIN',
    build: () {
      when(() => manager.verifyOtp(any(), any())).thenAnswer(
        (_) async => _result(isNewUser: true, pinSet: false),
      );
      // Gate ON: the cubit routes off the manager's resolved status; a new user
      // resolves to `locked` (must set a PIN).
      when(() => manager.persistentAuthEnabled).thenReturn(true);
      when(() => manager.status).thenReturn(AuthStatus.locked);
      return OtpVerifyCubit(manager);
    },
    act: (OtpVerifyCubit c) => c.verify(phone: '+919912345678', otp: '1234'),
    expect: () => const <OtpVerifyState>[
      OtpVerifyState(status: OtpVerifyStatus.submitting),
      OtpVerifyState(status: OtpVerifyStatus.success, next: OtpNext.setPin),
    ],
    verify: (_) =>
        verify(() => manager.verifyOtp('+919912345678', '1234')).called(1),
  );

  blocTest<OtpVerifyCubit, OtpVerifyState>(
    'returning user with PIN -> success routes straight to authenticated',
    build: () {
      when(() => manager.verifyOtp(any(), any())).thenAnswer(
        (_) async => _result(isNewUser: false, pinSet: true),
      );
      // Gate ON: a returning worker with a PIN resolves straight to
      // `authenticated`.
      when(() => manager.persistentAuthEnabled).thenReturn(true);
      when(() => manager.status).thenReturn(AuthStatus.authenticated);
      return OtpVerifyCubit(manager);
    },
    act: (OtpVerifyCubit c) => c.verify(phone: '+919912345678', otp: '1234'),
    expect: () => const <OtpVerifyState>[
      OtpVerifyState(status: OtpVerifyStatus.submitting),
      OtpVerifyState(
          status: OtpVerifyStatus.success, next: OtpNext.authenticated),
    ],
  );

  blocTest<OtpVerifyCubit, OtpVerifyState>(
    'gate OFF (real/default build) -> success routes to main\'s onboarding',
    build: () {
      when(() => manager.verifyOtp(any(), any())).thenAnswer(
        (_) async => _result(isNewUser: false, pinSet: false),
      );
      // Gate OFF: regardless of status, the cubit routes to onboarding (main's
      // OTP→consent flow). The manager resolves to `authenticated` on the real
      // path, but the gate check wins before status is ever read.
      when(() => manager.persistentAuthEnabled).thenReturn(false);
      when(() => manager.status).thenReturn(AuthStatus.authenticated);
      return OtpVerifyCubit(manager);
    },
    act: (OtpVerifyCubit c) => c.verify(phone: '+919912345678', otp: '1234'),
    expect: () => const <OtpVerifyState>[
      OtpVerifyState(status: OtpVerifyStatus.submitting),
      OtpVerifyState(status: OtpVerifyStatus.success, next: OtpNext.onboarding),
    ],
  );

  blocTest<OtpVerifyCubit, OtpVerifyState>(
    'failure -> submitting then failure with localized AuthFailure copy',
    build: () {
      when(() => manager.verifyOtp(any(), any()))
          .thenThrow(const AuthFailure(AuthErrorCode.otpInvalid));
      return OtpVerifyCubit(manager, locale: 'en');
    },
    act: (OtpVerifyCubit c) => c.verify(phone: '+919912345678', otp: '1234'),
    expect: () => const <OtpVerifyState>[
      OtpVerifyState(status: OtpVerifyStatus.submitting),
      OtpVerifyState(
          status: OtpVerifyStatus.failure,
          message: 'Wrong code. Please re-enter.'),
    ],
  );

  // Re-entrancy guard: a double-tap while a verify is in flight must not fire a
  // second verifyOtp.
  blocTest<OtpVerifyCubit, OtpVerifyState>(
    'a double verify while in flight only calls the manager once',
    build: () {
      when(() => manager.verifyOtp(any(), any())).thenAnswer(
        (_) async {
          await Future<void>.delayed(const Duration(milliseconds: 50));
          return _result(isNewUser: false, pinSet: true);
        },
      );
      when(() => manager.persistentAuthEnabled).thenReturn(true);
      when(() => manager.status).thenReturn(AuthStatus.authenticated);
      return OtpVerifyCubit(manager);
    },
    act: (OtpVerifyCubit c) {
      c.verify(phone: '+919912345678', otp: '1234'); // in flight
      c.verify(phone: '+919912345678', otp: '1234'); // dropped by the guard
    },
    wait: const Duration(milliseconds: 80),
    expect: () => const <OtpVerifyState>[
      OtpVerifyState(status: OtpVerifyStatus.submitting),
      OtpVerifyState(
          status: OtpVerifyStatus.success, next: OtpNext.authenticated),
    ],
    verify: (_) =>
        verify(() => manager.verifyOtp('+919912345678', '1234')).called(1),
  );
}

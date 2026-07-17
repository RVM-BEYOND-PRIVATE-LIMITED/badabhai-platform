import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/otp/sms_otp_autofill.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/phone_login_cubit.dart';

class MockAuthSessionManager extends Mock implements AuthSessionManager {}

class MockSmsOtpAutofill extends Mock implements SmsOtpAutofill {}

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

  // SMS User Consent only matches a message that arrives AFTER the window opens,
  // and the OTP SMS can land within a second of the request. Opening it after
  // requestOtp would race the SMS and silently lose the auto-read — so the
  // ORDER is the contract here, not just the call.
  test('opens the SMS auto-read window BEFORE requesting the OTP', () async {
    final MockSmsOtpAutofill autofill = MockSmsOtpAutofill();
    final List<String> order = <String>[];

    when(() => autofill.startListening()).thenAnswer((_) async {
      order.add('startListening');
    });
    when(() => manager.requestOtp(any())).thenAnswer((_) async {
      order.add('requestOtp');
      return const OtpRequestResult(resendIn: Duration(seconds: 30));
    });

    await PhoneLoginCubit(manager, otpAutofill: autofill)
        .submit('+919912345678');

    expect(order, <String>['startListening', 'requestOtp']);
  });

  // The phone is only validated server-side, so a half-typed number still
  // reaches submit. Opening a 5-minute consent window for a request that cannot
  // produce an SMS would leave it listening — and an unrelated OTP (a bank,
  // another app) would then pop a baffling "Allow BadaBhai to read this?".
  test('a half-typed number never opens the SMS window', () async {
    final MockSmsOtpAutofill autofill = MockSmsOtpAutofill();
    when(() => autofill.startListening()).thenAnswer((_) async {});
    when(() => manager.requestOtp(any()))
        .thenThrow(const AuthFailure(AuthErrorCode.network));

    await PhoneLoginCubit(manager, otpAutofill: autofill).submit('+91');

    verifyNever(() => autofill.startListening());
  });

  test('a complete number does open the SMS window', () async {
    final MockSmsOtpAutofill autofill = MockSmsOtpAutofill();
    when(() => autofill.startListening()).thenAnswer((_) async {});
    when(() => manager.requestOtp(any())).thenAnswer(
      (_) async => const OtpRequestResult(resendIn: Duration(seconds: 30)),
    );

    await PhoneLoginCubit(manager, otpAutofill: autofill)
        .submit('+919876500000');

    verify(() => autofill.startListening()).called(1);
  });

  // Auto-read is a convenience. A device with no Play Services must still be
  // able to receive an OTP and type it.
  test('a failing autofill never blocks the OTP request', () async {
    final MockSmsOtpAutofill autofill = MockSmsOtpAutofill();
    when(() => autofill.startListening()).thenThrow(Exception('no gms'));
    when(() => manager.requestOtp(any())).thenAnswer(
      (_) async => const OtpRequestResult(resendIn: Duration(seconds: 30)),
    );

    final PhoneLoginCubit cubit =
        PhoneLoginCubit(manager, otpAutofill: autofill);
    await cubit.submit('+919912345678');

    expect(cubit.state.status, PhoneLoginStatus.success);
    verify(() => manager.requestOtp('+919912345678')).called(1);
  });
}

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/auth/phone_format.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/otp_verify_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/phone_login_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/cubit/set_pin_cubit.dart';
import 'package:badabhai_worker_app/features/auth/presentation/otp_verify_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/phone_login_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/set_pin_screen.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_view.dart';
import 'package:badabhai_worker_app/features/consent/domain/consent_repository.dart';
import 'package:badabhai_worker_app/features/consent/presentation/consent_screen.dart';
import 'package:badabhai_worker_app/features/consent/presentation/cubit/consent_cubit.dart';
import 'package:badabhai_worker_app/features/splash/presentation/splash_screen.dart';

class _MockManager extends Mock implements AuthSessionManager {}

class _MockConsentRepo extends Mock implements ConsentRepository {}

/// The onboarding kit is drawn at ~390pt. These five screens must run on EVERY
/// device a worker owns — so each is pumped across the small, common, tall,
/// tablet and landscape sizes, at 100%, 150% and 200% system font, and must not
/// throw a single overflow (a RenderFlex overflow surfaces through
/// `takeException`), while its primary CTA is still in the tree.
void main() {
  const List<Size> sizes = <Size>[
    Size(320, 568), // smallest supported (iPhone SE 1 / budget Android)
    Size(360, 640), // the common budget Android
    Size(390, 844), // the kit's artboard
    Size(412, 915), // tall Android
    Size(768, 1024), // tablet portrait
    Size(844, 390), // phone landscape
  ];
  const List<double> textScales = <double>[1.0, 1.5, 2.0];

  setUpAll(() {
    BbPinView.debugDeterministicCaret = true;
    registerFallbackValue(const <String>[]);
  });
  tearDownAll(() => BbPinView.debugDeterministicCaret = false);

  setUp(() async {
    await locator.reset();
    final _MockManager manager = _MockManager();
    when(() => manager.requestOtp(any()))
        .thenThrow(const AuthFailure(AuthErrorCode.network));
    when(() => manager.verifyOtp(any(), any()))
        .thenThrow(const AuthFailure(AuthErrorCode.otpInvalid));
    locator.registerSingleton<AuthSessionManager>(manager);
    locator.registerFactory<PhoneLoginCubit>(
        () => PhoneLoginCubit(manager, locale: 'en'));
    locator.registerFactory<OtpVerifyCubit>(
        () => OtpVerifyCubit(manager, locale: 'en'));
    locator.registerFactory<SetPinCubit>(() => SetPinCubit(manager));
    final _MockConsentRepo repo = _MockConsentRepo();
    when(() => repo.acceptConsent(purposes: any(named: 'purposes')))
        .thenAnswer((_) async {});
    locator.registerFactory<ConsentCubit>(() => ConsentCubit(repo));
  });

  tearDown(() => locator.reset());

  final Map<String, (Widget Function(), String)> screens =
      <String, (Widget Function(), String)>{
    'splash': (() => const SplashScreen(), 'Get started'),
    'phone login': (() => const PhoneLoginScreen(), 'Send OTP'),
    'otp verify': (
      () => const OtpVerifyScreen(phone: '+919876543210'),
      'Verify Code'
    ),
    'set pin': (() => const SetPinScreen(), 'Save PIN & Continue'),
    'consent': (() => const ConsentScreen(), 'Aage Badhein'),
  };

  for (final MapEntry<String, (Widget Function(), String)> screen
      in screens.entries) {
    group(screen.key, () {
      for (final Size size in sizes) {
        for (final double scale in textScales) {
          testWidgets(
              '${size.width.toInt()}x${size.height.toInt()} @ ${scale}x text: '
              'no overflow, CTA present', (WidgetTester tester) async {
            tester.view.physicalSize = size;
            tester.view.devicePixelRatio = 1.0;
            addTearDown(tester.view.resetPhysicalSize);
            addTearDown(tester.view.resetDevicePixelRatio);

            await tester.pumpWidget(MaterialApp(
              builder: (BuildContext context, Widget? child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: screen.value.$1(),
            ));
            await tester.pump();
            await tester.pump(const Duration(milliseconds: 400));

            expect(tester.takeException(), isNull,
                reason: '${screen.key} threw at $size, text x$scale');
            expect(find.text(screen.value.$2), findsOneWidget,
                reason: 'primary CTA missing on ${screen.key} at $size');

            // Unmount so no timer/animation outlives the test.
            await tester.pumpWidget(const SizedBox.shrink());
          });
        }
      }
    });
  }

  test('OTP subtitle formats the phone the way the kit writes it', () {
    expect(formatIndianPhoneForDisplay('+919876543210'), '+91 98765 43210');
    expect(formatIndianPhoneForDisplay('9876543210'), '+91 98765 43210');
    // Not an Indian mobile — shown as-is, never reshaped into another number.
    expect(formatIndianPhoneForDisplay('+14155550100'), '+14155550100');
    expect(formatIndianPhoneForDisplay(''), '');
  });
}

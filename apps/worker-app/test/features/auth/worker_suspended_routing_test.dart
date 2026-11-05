// #2687 — a suspended refusal on ANY call site reaches the ONE app-level
// suspended destination, never the consent/sign-in loop.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/app.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/auth_failure.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/mock_auth_api.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/auth/worker_suspended_signal.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_keypad.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_view.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';
import 'package:badabhai_worker_app/features/suspended/presentation/suspended_account_screen.dart';

import '../../core/auth/fakes.dart';

class _ScriptableApi extends MockAuthApi {
  _ScriptableApi(super.tokenStore);

  AuthFailure? otpVerifyFailure;
  AuthFailure? pinVerifyFailure;

  @override
  Future<OtpVerifyResult> otpVerify(String phone, String otp) async {
    if (otpVerifyFailure != null) throw otpVerifyFailure!;
    return super.otpVerify(phone, otp);
  }

  @override
  Future<PinVerifyResult> pinVerify(
    String pin, {
    required String refreshToken,
  }) async {
    if (pinVerifyFailure != null) throw pinVerifyFailure!;
    return super.pinVerify(pin, refreshToken: refreshToken);
  }
}

Future<void> _pumpUntil(
  WidgetTester tester,
  Finder finder, {
  int maxFrames = 60,
}) async {
  for (int i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) {
      await tester.pump(const Duration(milliseconds: 300));
      return;
    }
  }
  expect(finder, findsWidgets);
}

Future<void> _wire({
  required bool seedRefresh,
  required _ScriptableApi api,
}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  final FakeSecureStore secure = FakeSecureStore();
  setupLocator(apiClient: MockApiClient(), secureStore: secure);
  final SecureTokenStore store = locator<SecureTokenStore>();
  if (seedRefresh) {
    await store.writeRefreshToken('remembered');
    await store.writeWorkerId('worker-7');
    await store.writePinSet(true);
  }
  await initAuthLocator(
    localeStore: LocaleStore(FakePrefs()),
    authApi: api,
    persistentAuthEnabled: true,
  );
  await locator<AuthSessionManager>().bootstrap();
}

void _bigCanvas(WidgetTester tester) {
  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

Future<void> _enterPin(WidgetTester tester, String pin) async {
  for (final String d in pin.split('')) {
    await tester.tap(
      find.descendant(of: find.byType(BbPinKeypad), matching: find.text(d)),
    );
    await tester.pump();
  }
}

void main() {
  setUpAll(() => BbPinView.debugDeterministicCaret = true);
  tearDownAll(() => BbPinView.debugDeterministicCaret = false);

  setUp(() {
    ResumeCubit.documentPollMaxAttempts = 1;
    ResumeCubit.documentPollInterval = Duration.zero;
  });

  tearDown(() async {
    ResumeCubit.documentPollMaxAttempts = 6;
    ResumeCubit.documentPollInterval = const Duration(seconds: 2);
    await locator.reset();
  });

  testWidgets('PIN unlock refusal shows the suspended screen with DPDP exits', (
    WidgetTester tester,
  ) async {
    _bigCanvas(tester);
    final FakeSecureStore secure = FakeSecureStore();
    final _ScriptableApi api = _ScriptableApi(SecureTokenStore(secure))
      ..pinVerifyFailure = const AuthFailure(
        AuthErrorCode.workerSuspended,
        restrictedToken: 'restricted-pin',
      );
    await _wire(seedRefresh: true, api: api);

    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));
    await _enterPin(tester, '1234');
    await _pumpUntil(tester, find.text(kSuspendedTitle));

    expect(find.text(kSuspendedTitle), findsOneWidget);
    expect(find.text(kSuspendedSupport), findsOneWidget);
    expect(
      find.byKey(kSuspendedDeleteButtonKey),
      findsOneWidget,
      reason: 'the restricted token enables the DPDP exits',
    );
    expect(find.text('Send OTP'), findsNothing);
    expect(find.text('Verify OTP'), findsNothing);
    expect(locator<AuthSessionManager>().status, AuthStatus.loggedOut);
    expect(
      await locator<SecureTokenStore>().readRefreshToken(),
      isNull,
      reason: 'local session state is cleared',
    );
  });

  testWidgets(
    'phone-code verify refusal shows the suspended screen (no token)',
    (WidgetTester tester) async {
      _bigCanvas(tester);
      final FakeSecureStore secure = FakeSecureStore();
      final _ScriptableApi api = _ScriptableApi(SecureTokenStore(secure))
        ..otpVerifyFailure = const AuthFailure(AuthErrorCode.workerSuspended);
      await _wire(seedRefresh: false, api: api);

      await tester.pumpWidget(const BadaBhaiApp());
      await _pumpUntil(tester, find.text('Get started'));
      await tester.tap(find.text('Get started'));
      await _pumpUntil(tester, find.text('Send OTP'));
      await tester.enterText(find.byType(TextField).first, '9876543210');
      await tester.pump();
      await tester.tap(find.text('Send OTP'));
      await _pumpUntil(tester, find.text('Verify OTP'));

      await tester.enterText(find.byKey(const Key('otpCodeField')), '123456');
      await tester.pump();
      await tester.tap(find.text('Verify Code'));
      await _pumpUntil(tester, find.text(kSuspendedTitle));

      expect(find.text(kSuspendedTitle), findsOneWidget);
      expect(find.text(kSuspendedSupport), findsOneWidget);
      expect(
        find.byKey(kSuspendedDeleteButtonKey),
        findsNothing,
        reason: 'older backends send no token → message + support only',
      );
      expect(find.byKey(kSuspendedWithdrawButtonKey), findsNothing);
      expect(find.text('Send OTP'), findsNothing);
    },
  );

  testWidgets('the generic suspended signal routes the app and never loops', (
    WidgetTester tester,
  ) async {
    _bigCanvas(tester);
    final FakeSecureStore secure = FakeSecureStore();
    final _ScriptableApi api = _ScriptableApi(SecureTokenStore(secure));
    await _wire(seedRefresh: false, api: api);

    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('Get started'));
    await tester.tap(find.text('Get started'));
    await _pumpUntil(tester, find.text('Send OTP'));

    locator<WorkerSuspendedSignal>().fire(
      const WorkerSuspension(restrictedToken: 'restricted-generic'),
    );
    await _pumpUntil(tester, find.text(kSuspendedTitle));

    expect(find.text(kSuspendedTitle), findsOneWidget);
    expect(find.byKey(kSuspendedDeleteButtonKey), findsOneWidget);
    // Give the redirect several more frames: it must not bounce to login or
    // consent after handling the suspension.
    for (int i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 100));
    }
    expect(find.text(kSuspendedTitle), findsOneWidget);
    expect(find.text('Send OTP'), findsNothing);
    expect(find.text('Verify OTP'), findsNothing);
  });
}

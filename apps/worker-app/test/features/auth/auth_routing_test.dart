// App-open routing + PIN-screen UX, driven through the REAL router redirect.
//
// Pumps the whole [BadaBhaiApp] with the auth graph wired over fakes + a
// MockAuthApi, then asserts the cold-start landing screen and the unlock flow.
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
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_keypad.dart';

import '../../core/auth/fakes.dart';

/// A MockAuthApi whose pinVerify can be scripted to fail (lockout / invalid).
class ScriptablePinApi extends MockAuthApi {
  ScriptablePinApi(super.tokenStore);

  AuthFailure? pinVerifyFailure;

  @override
  Future<AuthTokens> pinVerify(String pin, {required String refreshToken}) {
    final AuthFailure? f = pinVerifyFailure;
    if (f != null) throw f;
    return super.pinVerify(pin, refreshToken: refreshToken);
  }
}

Future<void> _pumpUntil(WidgetTester tester, Finder finder,
    {int maxFrames = 50}) async {
  for (int i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) {
      await tester.pump(const Duration(milliseconds: 400));
      return;
    }
  }
  expect(finder, findsWidgets,
      reason: 'timed out waiting for $finder');
}

Future<void> _enterPin(WidgetTester tester, String pin) async {
  for (final String d in pin.split('')) {
    await tester.tap(find.descendant(
      of: find.byType(BbPinKeypad),
      matching: find.text(d),
    ));
    await tester.pump();
  }
}

/// What the wiring produced — the fake secure store + (optionally) the scriptable
/// PIN api built over the WIRED store.
class _Wired {
  _Wired(this.secure, this.pinApi);
  final FakeSecureStore secure;
  final ScriptablePinApi? pinApi;
}

/// Wires the full app graph over fakes. [seedRefresh] pre-seeds a remembered
/// refresh token (a returning device); [scriptPin] swaps in a [ScriptablePinApi]
/// (built over the SAME wired store) so a test can force PIN failures.
Future<_Wired> _wire(
    {required bool seedRefresh, bool scriptPin = false}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  final FakeSecureStore secure = FakeSecureStore();
  setupLocator(apiClient: MockApiClient(), secureStore: secure);
  final SecureTokenStore store = locator<SecureTokenStore>();
  if (seedRefresh) {
    await store.writeRefreshToken('remembered-refresh');
    await store.writeWorkerId('worker-7');
    await store.writePinSet(true);
  }
  final ScriptablePinApi? pinApi = scriptPin ? ScriptablePinApi(store) : null;
  await initAuthLocator(
    localeStore: LocaleStore(FakePrefs()),
    authApi: pinApi ?? MockAuthApi(store),
  );
  await locator<AuthSessionManager>().bootstrap();
  return _Wired(secure, pinApi);
}

void main() {
  setUp(() {
    // A roomy canvas so the keypad + dots never clip under the test fallback font.
    // (Re-applied per test via tester.view.)
  });

  tearDown(() async {
    await locator.reset();
  });

  void bigCanvas(WidgetTester tester) {
    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets('cold start WITH a refresh token -> enter-PIN (/pin)',
      (WidgetTester tester) async {
    bigCanvas(tester);
    await _wire(seedRefresh: true);
    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));

    // Landed on the enter-PIN fast path, NOT the phone login or splash.
    expect(find.text('PIN daalein'), findsOneWidget);
    expect(find.text('Send OTP'), findsNothing);
  });

  testWidgets('cold start WITHOUT a refresh token -> phone login (/login)',
      (WidgetTester tester) async {
    bigCanvas(tester);
    await _wire(seedRefresh: false);
    await tester.pumpWidget(const BadaBhaiApp());
    // Splash renders first; tapping through lands on login. With no token the
    // redirect never forces /pin.
    await _pumpUntil(tester, find.text('Get started'));
    await tester.tap(find.text('Get started'));
    await _pumpUntil(tester, find.text('Send OTP'));
    expect(find.text('Send OTP'), findsOneWidget);
    expect(find.text('PIN daalein'), findsNothing);
  });

  testWidgets(
      'returning unlock -> shell (no re-profiling: never hits consent/chat)',
      (WidgetTester tester) async {
    bigCanvas(tester);
    await _wire(seedRefresh: true);
    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));

    await _enterPin(tester, '7416'); // any 4 digits — mock accepts
    await _pumpUntil(tester, find.text('Your resume'));

    // Straight into the shell (Resume tab). The onboarding never re-ran.
    expect(find.text('Your resume'), findsOneWidget);
    expect(find.text('Your privacy'), findsNothing); // consent never shown
  });

  testWidgets('PIN_INVALID shows attempts-left and stays on the PIN screen',
      (WidgetTester tester) async {
    bigCanvas(tester);
    final _Wired w = await _wire(seedRefresh: true, scriptPin: true);
    w.pinApi!.pinVerifyFailure =
        const AuthFailure(AuthErrorCode.pinInvalid, attemptsLeft: 2);

    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));

    await _enterPin(tester, '0000');
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.text('Galat PIN (2 tries bachi).'), findsOneWidget);
    expect(find.text('PIN daalein'), findsOneWidget); // still locked screen
  });

  testWidgets('PIN_LOCKED disables the keypad and shows a countdown',
      (WidgetTester tester) async {
    bigCanvas(tester);
    final _Wired w = await _wire(seedRefresh: true, scriptPin: true);
    w.pinApi!.pinVerifyFailure = const AuthFailure(
      AuthErrorCode.pinLocked,
      retryAfter: Duration(minutes: 2),
    );

    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));

    await _enterPin(tester, '0000');
    await tester.pump(const Duration(milliseconds: 400));

    expect(
      find.text('Bahut galat tries — 2 minute baad dobara try karein.'),
      findsOneWidget,
    );
    // Keypad disabled: a further tap must NOT add a dot / call verify again.
    await tester.tap(find.descendant(
      of: find.byType(BbPinKeypad),
      matching: find.text('1'),
    ));
    await tester.pump();
    // Still showing the lock copy (no new verify attempt cleared it).
    expect(
      find.text('Bahut galat tries — 2 minute baad dobara try karein.'),
      findsOneWidget,
    );
  });
}

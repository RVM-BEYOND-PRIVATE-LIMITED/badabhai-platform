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

/// A MockAuthApi whose pinVerify can be scripted to fail (lockout / invalid)
/// or to return a scripted TD62 `consent_accepted` signal.
class ScriptablePinApi extends MockAuthApi {
  ScriptablePinApi(super.tokenStore);

  AuthFailure? pinVerifyFailure;

  /// When [scriptConsent] is true, [consentAccepted] overrides the mock's
  /// default `consentAccepted: true` on pinVerify (TD62). `false` simulates a
  /// never-onboarded worker; `null` simulates an OLD server (field absent).
  bool scriptConsent = false;
  bool? consentAccepted;

  @override
  Future<PinVerifyResult> pinVerify(String pin,
      {required String refreshToken}) async {
    final AuthFailure? f = pinVerifyFailure;
    if (f != null) throw f;
    final PinVerifyResult result =
        await super.pinVerify(pin, refreshToken: refreshToken);
    if (!scriptConsent) return result;
    return PinVerifyResult(
      tokens: result.tokens,
      consentAccepted: consentAccepted,
    );
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
/// [persistentAuth] toggles the PIN/lock gate — `false` exercises the inert
/// (main-like) redirect (the real/default build).
Future<_Wired> _wire(
    {required bool seedRefresh,
    bool scriptPin = false,
    bool persistentAuth = true}) async {
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
    persistentAuthEnabled: persistentAuth,
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
      'gate OFF (real/default build): redirect is INERT — a remembered token '
      'does NOT force /pin; routing matches main',
      (WidgetTester tester) async {
    bigCanvas(tester);
    // Seed a refresh token AND disable the gate: with the gate ON this cold-starts
    // LOCKED (/pin). With it OFF, bootstrap short-circuits to loggedOut and the
    // redirect never fires, so the worker can walk splash → login exactly as main.
    await _wire(seedRefresh: true, persistentAuth: false);
    await tester.pumpWidget(const BadaBhaiApp());

    await _pumpUntil(tester, find.text('Get started'));
    expect(find.text('PIN daalein'), findsNothing); // never bounced to /pin
    await tester.tap(find.text('Get started'));
    await _pumpUntil(tester, find.text('Send OTP'));

    // Reached the phone-login surface — not force-redirected to /login or /pin.
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

    // Settle the ResumePhotoHeader's best-effort resume-fields fetch (ADR-0032,
    // mounts with the resume card; mock latency 300ms) so no timer outlives the test.
    await tester.pump(const Duration(milliseconds: 700));
  });

  testWidgets(
      'TD62: unlock with consent_accepted=false -> the CONSENT gate, not the '
      'shell', (WidgetTester tester) async {
    bigCanvas(tester);
    final _Wired w = await _wire(seedRefresh: true, scriptPin: true);
    // A never-onboarded worker: the server says there is NO active consent.
    w.pinApi!
      ..scriptConsent = true
      ..consentAccepted = false;

    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));

    await _enterPin(tester, '7416');
    await _pumpUntil(tester, find.text('Your privacy'));

    // Forced to /consent (DPDP gate) — the shell is NOT reachable yet.
    expect(find.text('Your privacy'), findsOneWidget);
    expect(find.text('Your resume'), findsNothing);
  });

  testWidgets(
      'TD62: unlock against an OLD server (consent_accepted ABSENT -> null) '
      'passes through to the shell (never bricks routing)',
      (WidgetTester tester) async {
    bigCanvas(tester);
    final _Wired w = await _wire(seedRefresh: true, scriptPin: true);
    // Old-server shape: the field is absent — the tri-state stays null.
    w.pinApi!
      ..scriptConsent = true
      ..consentAccepted = null;

    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));

    await _enterPin(tester, '7416');
    await _pumpUntil(tester, find.text('Your resume'));

    // Null = unknown → no consent bounce; the proven unlock→shell flow holds.
    expect(find.text('Your resume'), findsOneWidget);
    expect(find.text('Your privacy'), findsNothing);

    // Settle the ResumePhotoHeader's best-effort resume-fields fetch (ADR-0032,
    // mounts with the resume card; mock latency 300ms) so no timer outlives the test.
    await tester.pump(const Duration(milliseconds: 700));
  });

  testWidgets(
      'a failed PIN shows NEUTRAL copy (no attempts/countdown) and stays on '
      'the PIN screen', (WidgetTester tester) async {
    bigCanvas(tester);
    final _Wired w = await _wire(seedRefresh: true, scriptPin: true);
    // The real backend returns one opaque 401 per failure → pinVerifyFailed.
    w.pinApi!.pinVerifyFailure =
        const AuthFailure(AuthErrorCode.pinVerifyFailed);

    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));

    await _enterPin(tester, '0000');
    await tester.pump(const Duration(milliseconds: 400));

    // Neutral PIN line — no "tries bachi" / countdown copy anywhere.
    expect(
      find.text("PIN sahi nahi — dobara try karein, ya 'PIN bhool gaye?'"),
      findsOneWidget,
    );
    expect(find.textContaining('tries'), findsNothing);
    expect(find.textContaining('minute'), findsNothing);
    expect(find.text('PIN daalein'), findsOneWidget); // still on the PIN screen

    // The keypad is NOT disabled (no lockout) — another digit registers.
    await tester.tap(find.descendant(
      of: find.byType(BbPinKeypad),
      matching: find.text('1'),
    ));
    await tester.pump();
    // A partial entry doesn't auto-submit; still on the PIN screen.
    expect(find.text('PIN daalein'), findsOneWidget);
  });

  testWidgets('after ≥3 soft fails the screen nudges toward forgot-PIN',
      (WidgetTester tester) async {
    bigCanvas(tester);
    final _Wired w = await _wire(seedRefresh: true, scriptPin: true);
    w.pinApi!.pinVerifyFailure =
        const AuthFailure(AuthErrorCode.pinVerifyFailed);

    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));

    // Below the threshold the gentle link shows.
    expect(find.text('PIN bhool gaye?'), findsOneWidget);

    for (int i = 0; i < 3; i++) {
      await _enterPin(tester, '0000');
      await tester.pump(const Duration(milliseconds: 400));
    }

    // After 3 fails the emphasized nudge replaces the plain link.
    expect(find.text('PIN bhool gaye? Naya PIN banayein'), findsOneWidget);
  });
}

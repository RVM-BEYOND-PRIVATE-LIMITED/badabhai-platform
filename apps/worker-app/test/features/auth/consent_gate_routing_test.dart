// Router-level DPDP consent gate (FIX #172-#1): a returning-but-never-consented
// worker must NOT skip into the shell — the router holds them at /consent.
//
// This drives the WHOLE app through the REAL go_router redirect (gate ON), over
// fakes + a scriptable MockAuthApi that reports the server `consent_accepted`
// flag. It asserts the gate on BOTH entry points that reach `authenticated`:
//   * the cold PIN-UNLOCK path (seedRefresh → /pin → enter PIN → pinVerify), and
//   * the OTP-VERIFY path (splash → login → OTP → verify),
// for a CONSENTED worker (→ shell / "Your resume") and an UNCONSENTED one (→
// /consent / "Your privacy"), plus the MISSING-field safe default (omitted on the
// wire → treated as false → /consent).
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/app.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/auth/auth_api.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/mock_auth_api.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_keypad.dart';

import '../../core/auth/fakes.dart';

/// A MockAuthApi whose OTP-verify + PIN-verify responses carry a scripted
/// `consent_accepted`. A `null` OMITS the field from the wire body entirely, so
/// the real [AuthTokens.fromJson] default (→ false) is exercised.
class ConsentScriptApi extends MockAuthApi {
  ConsentScriptApi(super.store);

  bool? otpConsent = true;
  bool? pinConsent = true;
  bool pinAlreadySet = true; // pin_set on the login response
  bool newWorker = false; // is_new_worker on the login response

  Map<String, dynamic> _tokenBody(String access, String refresh, bool? consent) =>
      <String, dynamic>{
        'access_token': access,
        'refresh_token': refresh,
        'expires_in_seconds': 900,
        if (consent != null) 'consent_accepted': consent,
      };

  @override
  Future<OtpVerifyResult> otpVerify(String phone, String otp) async {
    final OtpVerifyResult base = await super.otpVerify(phone, otp);
    return OtpVerifyResult(
      workerId: base.workerId,
      isNewUser: newWorker,
      pinSet: pinAlreadySet,
      tokens: AuthTokens.fromJson(
          _tokenBody('access-otp', 'refresh-otp', otpConsent)),
    );
  }

  @override
  Future<AuthTokens> pinVerify(String pin, {required String refreshToken}) async {
    await super.pinVerify(pin, refreshToken: refreshToken); // mock delay + store
    return AuthTokens.fromJson(
        _tokenBody('access-unlock', 'refresh-unlock', pinConsent));
  }
}

Future<void> _pumpUntil(WidgetTester tester, Finder finder,
    {int maxFrames = 50}) async {
  for (int i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) {
      await tester.pump(const Duration(milliseconds: 500));
      return;
    }
  }
  expect(finder, findsWidgets, reason: 'timed out waiting for $finder');
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

/// Wires the full app graph over fakes with the PIN/consent gate ON, installing a
/// [ConsentScriptApi]. [seedRefresh] pre-seeds a remembered device (the cold
/// PIN-unlock entry); without it the app cold-starts at phone login (the OTP
/// entry). Returns the scriptable api so a test can set the consent flags.
Future<ConsentScriptApi> _wire({required bool seedRefresh}) async {
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
  final ConsentScriptApi api = ConsentScriptApi(store);
  await initAuthLocator(
    localeStore: LocaleStore(FakePrefs()),
    authApi: api,
    persistentAuthEnabled: true,
  );
  await locator<AuthSessionManager>().bootstrap();
  return api;
}

void bigCanvas(WidgetTester tester) {
  tester.view.physicalSize = const Size(900, 1900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
}

/// Drive splash → login → OTP → verify for the OTP-entry tests.
Future<void> _walkOtp(WidgetTester tester) async {
  await _pumpUntil(tester, find.text('Get started'));
  await tester.tap(find.text('Get started'));
  await _pumpUntil(tester, find.text('Send OTP'));
  await tester.enterText(find.byType(TextField), '+919876500000');
  await tester.tap(find.text('Send OTP'));
  await _pumpUntil(tester, find.text('Verify'));
  await tester.enterText(find.byType(TextField), '123456');
  await tester.tap(find.text('Verify'));
}

void main() {
  tearDown(() async {
    await locator.reset();
  });

  group('cold PIN-unlock entry', () {
    testWidgets('CONSENTED returning worker -> shell (never shown /consent)',
        (WidgetTester tester) async {
      bigCanvas(tester);
      final ConsentScriptApi api = await _wire(seedRefresh: true);
      api.pinConsent = true;

      await tester.pumpWidget(const BadaBhaiApp());
      await _pumpUntil(tester, find.text('PIN daalein'));
      await _enterPin(tester, '7416');
      await _pumpUntil(tester, find.text('Your resume'));

      expect(find.text('Your resume'), findsOneWidget);
      expect(find.text('Your privacy'), findsNothing);
    });

    testWidgets('UNCONSENTED returning worker -> bounced to /consent',
        (WidgetTester tester) async {
      bigCanvas(tester);
      final ConsentScriptApi api = await _wire(seedRefresh: true);
      api.pinConsent = false;

      await tester.pumpWidget(const BadaBhaiApp());
      await _pumpUntil(tester, find.text('PIN daalein'));
      await _enterPin(tester, '7416');
      await _pumpUntil(tester, find.text('Your privacy'));

      // Held at consent — the §6 gate-ON bypass is closed on the PIN-unlock path.
      expect(find.text('Your privacy'), findsOneWidget);
      expect(find.text('Your resume'), findsNothing);
    });

    testWidgets('MISSING consent_accepted on the wire -> default false -> /consent',
        (WidgetTester tester) async {
      bigCanvas(tester);
      final ConsentScriptApi api = await _wire(seedRefresh: true);
      api.pinConsent = null; // omit the field entirely (older backend)

      await tester.pumpWidget(const BadaBhaiApp());
      await _pumpUntil(tester, find.text('PIN daalein'));
      await _enterPin(tester, '7416');
      await _pumpUntil(tester, find.text('Your privacy'));

      // Fail-safe: absent flag routes to consent rather than skipping it.
      expect(find.text('Your privacy'), findsOneWidget);
      expect(find.text('Your resume'), findsNothing);
    });
  });

  group('OTP-verify entry', () {
    testWidgets('CONSENTED returning worker -> shell', (WidgetTester tester) async {
      bigCanvas(tester);
      final ConsentScriptApi api = await _wire(seedRefresh: false);
      api
        ..otpConsent = true
        ..pinAlreadySet = true
        ..newWorker = false;

      await tester.pumpWidget(const BadaBhaiApp());
      await _walkOtp(tester);
      await _pumpUntil(tester, find.text('Your resume'));

      expect(find.text('Your resume'), findsOneWidget);
      expect(find.text('Your privacy'), findsNothing);
    });

    testWidgets('UNCONSENTED returning worker -> /consent',
        (WidgetTester tester) async {
      bigCanvas(tester);
      final ConsentScriptApi api = await _wire(seedRefresh: false);
      api
        ..otpConsent = false
        ..pinAlreadySet = true
        ..newWorker = false;

      await tester.pumpWidget(const BadaBhaiApp());
      await _walkOtp(tester);
      await _pumpUntil(tester, find.text('Your privacy'));

      // Held at consent — the gate-ON bypass is closed on the OTP-verify path too.
      expect(find.text('Your privacy'), findsOneWidget);
      expect(find.text('Your resume'), findsNothing);
    });
  });
}

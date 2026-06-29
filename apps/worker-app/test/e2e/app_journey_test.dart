// Mock-mode full-journey end-to-end test (Task E).
//
// Drives the WHOLE app — splash → login → otp → consent → chat → profile →
// building → the 4-tab shell — against [MockApiClient], then tabs through every
// branch. Dart-first and headless: it runs on the flutter_tester under the
// ordinary `flutter test` gate (no emulator, no device), so CI covers it.
//
//     flutter test test/e2e/app_journey_test.dart
//
// NOTE on placement: this is a widget-driven e2e under test/, NOT the
// `integration_test` package. That package routes integration_test/ to
// on-device / `flutter drive` runs and requires a connected device — which
// contradicts the mock-mode "Dart-first, not emulator" design and would fail
// the headless CI `flutter test` gate. Living under test/ keeps it deterministic
// and CI-covered.
//
// It uses the standard automated test binding, so `tester.pump(Duration)`
// advances a deterministic fake clock past the mock's ~300ms latency. We
// deliberately NEVER call `pumpAndSettle`: BuildingScreen's BbSpinner and the
// profiling CircularProgressIndicator animate forever and would time it out.
// Instead [_pumpUntil] advances in small steps until the next screen renders, so
// the journey is robust to retuned mock latency / the 900ms Building window
// rather than tied to a fixed frame count.
//
// Mock mode is forced through the [setupLocator] test seam (a [MockApiClient]
// override), so the journey works even though the compile-time `kUseMocks`
// dart-define is false under `flutter test`. No request can leave the device.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/app.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/mock_auth_api.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_nav.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_keypad.dart';

import '../core/auth/fakes.dart';

/// Pump the fake clock in small steps until [finder] matches, then return — or
/// fail loudly once the budget is spent. Avoids both `pumpAndSettle` (perpetual
/// spinners) and a brittle fixed frame count.
Future<void> _pumpUntil(WidgetTester tester, Finder finder,
    {int maxFrames = 50}) async {
  for (int i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isNotEmpty) {
      // Settle tail: the target can appear at the START of a go_router page
      // transition while the OUTGOING route is still on stage. Pump it out so
      // finders like find.byType(TextField) see only the now-current screen.
      await tester.pump(const Duration(milliseconds: 500));
      return;
    }
  }
  expect(finder, findsWidgets,
      reason: 'timed out (${maxFrames * 100}ms) waiting for $finder');
}

/// Inverse of [_pumpUntil]: advance until [finder] is gone (or fail loudly).
Future<void> _pumpUntilGone(WidgetTester tester, Finder finder,
    {int maxFrames = 50}) async {
  for (int i = 0; i < maxFrames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
    if (finder.evaluate().isEmpty) return;
  }
  expect(finder, findsNothing,
      reason: 'timed out (${maxFrames * 100}ms) waiting for $finder to clear');
}

/// The Alerts unread badge lives inside the bottom nav — scope to it so the
/// assertion can only pass via the real reactive count, not a stray '$n'.
Finder _navBadge(String count) => find.descendant(
      of: find.byType(BbBottomNav),
      matching: find.text(count),
    );

/// Tap the masked PIN keypad to enter [pin] (digit by digit). The keypad has no
/// OS keyboard, so we tap the on-screen digit keys.
Future<void> _enterPin(WidgetTester tester, String pin) async {
  for (final String d in pin.split('')) {
    await tester.tap(find.descendant(
      of: find.byType(BbPinKeypad),
      matching: find.text(d),
    ));
    await tester.pump();
  }
}

void main() {
  setUp(() async {
    // No network, deterministic glyph metrics.
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    // Mock the whole stack: the ApiClient AND the auth subsystem. A fake secure
    // store + fake prefs stand in for the plugins (which throw under
    // `flutter test`), and MockAuthApi serves the OTP/PIN flow offline.
    final FakeSecureStore secure = FakeSecureStore();
    setupLocator(apiClient: MockApiClient(), secureStore: secure);
    await initAuthLocator(
      localeStore: LocaleStore(FakePrefs()),
      authApi: MockAuthApi(locator<SecureTokenStore>()),
    );
    // Cold start: no remembered token → loggedOut → the journey starts at login.
    await locator<AuthSessionManager>().bootstrap();
  });

  tearDown(() async {
    await locator.reset();
  });

  testWidgets('mock-mode journey: splash → onboarding → shell → all four tabs',
      (WidgetTester tester) async {
    // Canvas: 800 logical wide (the flutter_test default width, under which all
    // other suites render cleanly) and extra-tall so no column clips. We must
    // NOT narrow this: the test fallback font renders every glyph as a fixed 1em
    // box, so strings measure far wider than real Baloo 2 / Mukta — at phone
    // widths that yields spurious horizontal overflows (e.g. the profile rows)
    // that do not occur on device. Width is a test-measurement concern here, not
    // a layout bug.
    tester.view.physicalSize = const Size(800, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('Get started'));

    // ── 1. SPLASH — brand, the inert language picker (Task D), the CTA. ──
    expect(find.text('BadaBhai'), findsOneWidget);
    expect(find.text('हिंदी'), findsOneWidget);
    expect(find.text('English'), findsOneWidget);
    await tester.tap(find.text('मराठी')); // inert pick — no navigation
    await tester.pump();
    await tester.tap(find.text('Get started'));

    // ── 2. LOGIN — regression guard for the go_router push fix (was a stale
    //     Navigator.pushNamed that throws under MaterialApp.router). ──
    await _pumpUntil(tester, find.text('Send OTP'));
    await tester.enterText(find.byType(TextField), '+919876500000');
    await tester.tap(find.text('Send OTP'));

    // ── 3. OTP ──
    await _pumpUntil(tester, find.text('Verify'));
    await tester.enterText(find.byType(TextField), '123456');
    await tester.tap(find.text('Verify'));

    // ── 3b. SET-PIN (new user) — the OTP-verify flags route here (pin_set=false).
    //     Enter a PIN then confirm it; setPin authenticates and continues to
    //     consent (the onboarding). Masked keypad → tap the on-screen digits. ──
    await _pumpUntil(tester, find.text('4-digit PIN banayein'));
    await _enterPin(tester, '7416');
    await _pumpUntil(tester, find.text('PIN dobara daalein'));
    await _enterPin(tester, '7416');

    // ── 4. CONSENT (DPDP gate) ──
    await _pumpUntil(tester, find.text('Your privacy'));
    await tester.tap(find.text('I agree'));
    await _pumpUntil(tester, find.text('Continue'));
    await tester.tap(find.text('Continue'));

    // ── 4b. YOUR NAME — consent-gated capture (PATCH /workers/me/name), before
    //     the identity-free chat. Mock ApiClient.updateName is a no-op. ──
    await _pumpUntil(tester, find.text('Aapka naam?'));
    await tester.enterText(find.byType(TextField), 'Asha Kumari');
    await tester.pump();
    await tester.tap(find.text('Continue'));

    // ── 5. CHAT — send one message (exercises ChatRepository.sendMessage), then
    //     build the profile. ──
    await _pumpUntil(tester, find.text('Done — build my profile'));
    await tester.enterText(find.byType(TextField), 'CNC, 4 years, Fanuc');
    await tester.tap(find.byIcon(Icons.send_rounded));
    await _pumpUntil(tester, find.text('Done — build my profile'));
    await tester.tap(find.text('Done — build my profile'));

    // ── 6. PROFILE PREVIEW — extraction resolves, confirm to generate. ──
    await _pumpUntil(tester, find.text('Confirm & generate resume'));
    await tester.tap(find.text('Confirm & generate resume'));

    // ── 7. SHELL — landed on the Resume tab; onboarding stack cleared. ──
    await _pumpUntil(tester, find.text('Your resume'));
    expect(find.text('Your resume'), findsOneWidget);
    // The Alerts badge reflects the reactive unread count (mock seeds exactly 2)
    // — the ValueListenable wiring the nav badge depends on.
    expect(_navBadge('2'), findsOneWidget);

    // ── 8. TAB THROUGH every branch (each its own mock-backed screen). The
    //     IndexedStack offstages inactive branches, so default finders only see
    //     the active tab. ──
    await tester.tap(find.text('Jobs'));
    await _pumpUntil(tester, find.text('JOBS NEAR YOU'));
    expect(find.text('JOBS NEAR YOU'), findsOneWidget);

    await tester.tap(find.text('Profile'));
    await _pumpUntil(tester, find.text('Profile strength'));
    expect(find.text('Profile strength'), findsOneWidget);

    await tester.tap(find.text('Alerts'));
    await _pumpUntil(tester, find.byIcon(Icons.check));
    // Close the loop: mark-all-read clears the reactive unread badge.
    expect(_navBadge('2'), findsOneWidget);
    await tester.tap(find.byIcon(Icons.check));
    await _pumpUntilGone(tester, _navBadge('2'));
    expect(_navBadge('2'), findsNothing);

    await tester.tap(find.text('Resume'));
    await _pumpUntil(tester, find.text('Your resume'));
    expect(find.text('Your resume'), findsOneWidget);

    // NO-PII (client-side UI leak guard, NOT the §2 invariant — that boundary is
    // enforced/asserted server-side on events/ai_jobs/logs): the phone we typed
    // on the OTP screen never surfaces in the post-onboarding shell.
    expect(find.textContaining('9876500000'), findsNothing);
  });
}

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
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/core/widgets/bb_bottom_nav.dart';

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

void main() {
  setUp(() async {
    // No network, deterministic glyph metrics.
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockApiClient());
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

    // ── 4. CONSENT (DPDP gate) ──
    await _pumpUntil(tester, find.text('Your privacy'));
    await tester.tap(find.text('I agree'));
    await _pumpUntil(tester, find.text('Continue'));
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

// The end-to-end client half of the account-deletion flow: the backend has
// deleted the worker's row, the next authed call comes back 410
// { code: WORKER_ACCOUNT_DELETED }, the HTTP seam fires [AccountDeletedSignal],
// and the APP ROOT ([BadaBhaiApp]) must show ONE non-dismissible dialog and
// hard-logout on OK — leaving the manager `loggedOut` (→ the router bounces the
// worker to phone login so they can start again).
//
// Mock-mode + headless (flutter_tester), like the e2e journey: MockAuthApi serves
// OTP/PIN offline and fake plugins stand in for secure-storage / prefs. We fire
// the signal DIRECTLY (that a 410+code fires it is covered by the
// ApiClient/AuthedClient unit tests); here we prove the app-root listener +
// dialog + logout wiring. NEVER pumpAndSettle: the shell spins forever.
//
// The manager is driven to `authenticated` in setUp — the REAL-async zone, where
// MockAuthApi's `Future.delayed` latency resolves. Doing the same `await`s inside
// the testWidgets body would hang: there the clock only advances on `pump`.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/app.dart';
import 'package:badabhai_worker_app/core/api/mock_api_client.dart';
import 'package:badabhai_worker_app/core/auth/account_deleted_signal.dart';
import 'package:badabhai_worker_app/core/auth/locale_store.dart';
import 'package:badabhai_worker_app/core/auth/mock_auth_api.dart';
import 'package:badabhai_worker_app/core/auth/secure_token_store.dart';
import 'package:badabhai_worker_app/core/di/locator.dart';
import 'package:badabhai_worker_app/features/auth/domain/auth_session_manager.dart';
import 'package:badabhai_worker_app/features/notifications/data/notification_read_store.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';

import '../../core/auth/fakes.dart';

/// Pump the fake clock in fixed steps (never `pumpAndSettle`).
Future<void> _pump(WidgetTester tester, {int frames = 8}) async {
  for (int i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  late AuthSessionManager auth;

  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await locator.reset();
    setupLocator(apiClient: MockApiClient(), secureStore: FakeSecureStore());
    await initAuthLocator(
      localeStore: LocaleStore(FakePrefs()),
      authApi: MockAuthApi(locator<SecureTokenStore>()),
      readStore: const SessionOnlyNotificationReadStore(),
      persistentAuthEnabled: true,
    );
    auth = locator<AuthSessionManager>();
    await auth.bootstrap();
    // Drive to authenticated HERE (real-async) so OK → logout is a real
    // transition to loggedOut, without awaiting mock latency inside the test.
    await auth.verifyOtp('+919876500000', '123456'); // new mock user → locked
    await auth.setPin('1234'); // → authenticated
    // MockApiClient.getResumeDocument() deliberately always answers
    // `document: null` (see its own doc) — collapsed to a single attempt so
    // landing on the shell (Resume tab included) does not leave a real
    // pending Timer past this test's fixed pump sequence (see
    // ResumeCubit.documentPollInterval's own doc).
    ResumeCubit.documentPollMaxAttempts = 1;
    ResumeCubit.documentPollInterval = Duration.zero;
  });

  tearDown(() async {
    ResumeCubit.documentPollMaxAttempts = 6;
    ResumeCubit.documentPollInterval = const Duration(seconds: 2);
    await locator.reset();
  });

  testWidgets(
      'AccountDeletedSignal → one dialog; OK hard-logs-out (status loggedOut)',
      (WidgetTester tester) async {
    // Wide enough that the test fallback font's 1em glyph boxes do not spuriously
    // overflow the shell (see the e2e journey's note on canvas width).
    tester.view.physicalSize = const Size(800, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    expect(auth.status, AuthStatus.authenticated);

    await tester.pumpWidget(const BadaBhaiApp());
    await _pump(tester, frames: 12); // route onto a real screen

    // Backend deleted the account: the HTTP seam fires the app-scoped signal.
    locator<AccountDeletedSignal>().fire();
    await _pump(tester); // listener runs + dialog route pushes

    expect(find.text('Account nahi mila'), findsOneWidget,
        reason: 'the non-dismissible dialog is shown on the fire');
    expect(find.text('Theek hai'), findsOneWidget,
        reason: 'a single OK button');

    await tester.tap(find.text('Theek hai'));
    await _pump(tester); // dialog pops + logout() (mock ~300ms) completes

    expect(auth.status, AuthStatus.loggedOut,
        reason: 'OK hard-logs-out via AuthSessionManager.logout()');
    expect(find.text('Account nahi mila'), findsNothing,
        reason: 'the dialog is gone after OK');
  });

  testWidgets('a second fire while the dialog is up shows only ONE dialog',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(800, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const BadaBhaiApp());
    await _pump(tester, frames: 12);

    // Parallel 410s from concurrent in-flight calls.
    locator<AccountDeletedSignal>()
      ..fire()
      ..fire();
    await _pump(tester);

    expect(find.text('Account nahi mila'), findsOneWidget,
        reason: 'the guard collapses parallel 410s to a single dialog');
  });
}

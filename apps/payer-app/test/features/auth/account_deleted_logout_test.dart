// The app-root half of the payer account-deletion flow: the backend has deleted
// the payer's row, the next authed call comes back 410 { code:
// PAYER_ACCOUNT_DELETED }, PayerHttp fires [AccountDeletedSignal], and the app
// root ([PayerApp]'s `_Root`) must show ONE non-dismissible dialog and hard-
// logout on OK — wiping the bearer and emitting a null session (→ LoginScreen).
//
// Mock seam + headless (flutter_tester): a MockPayerApiClient serves canned data
// and an in-memory secure store stands in for the Keystore plugin. We fire the
// signal DIRECTLY (that a 410+code fires it is covered by the PayerHttp unit
// test); here we prove the app-root listener + dialog + signOut wiring. NEVER
// pumpAndSettle: the shell can hold an indefinite spinner.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:get_it/get_it.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:payer_app/app.dart';
import 'package:payer_app/core/auth/payer_account_deleted_signal.dart';
import 'package:payer_app/core/auth/payer_token_store.dart';
import 'package:payer_app/core/data/mock_payer_api_client.dart';
import 'package:payer_app/core/di/locator.dart';
import 'package:payer_app/core/session/app_session_cubit.dart';

/// Pump the fake clock in fixed steps (never `pumpAndSettle`).
Future<void> _pump(WidgetTester tester, {int frames = 8}) async {
  for (int i = 0; i < frames; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

void main() {
  setUp(() async {
    GoogleFonts.config.allowRuntimeFetching = false;
    await GetIt.instance.reset();
    setupLocator(
      apiClient: MockPayerApiClient(),
      secureStore: InMemoryKeyValueStore(),
    );
    // Seed a bearer so cold-start bootstrap restores a SIGNED-IN session (the
    // realistic state when a 410 arrives) — the dialog then overlays a live shell
    // and OK wipes a REAL token.
    await locator<PayerTokenStore>()
        .save(accessToken: 'tok', payerId: 'p1', role: 'employer');
  });

  tearDown(() async {
    await GetIt.instance.reset();
  });

  testWidgets('signal → one dialog; OK hard-logs-out (session null, token wiped)',
      (WidgetTester tester) async {
    // Wide enough that the test fallback font's glyph boxes do not spuriously
    // overflow the shell.
    tester.view.physicalSize = const Size(800, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const PayerApp());
    await _pump(tester, frames: 12); // boot resolves → signed-in shell

    final AppSessionCubit session = locator<AppSessionCubit>();
    expect(session.state, isNotNull, reason: 'bootstrap restored the session');
    expect(locator<PayerTokenStore>().hasSession, isTrue);

    // Backend deleted the account: the HTTP seam fires the app-scoped signal.
    locator<AccountDeletedSignal>().fire();
    await _pump(tester); // listener runs + dialog route pushes

    expect(find.text('Account nahi mila'), findsOneWidget,
        reason: 'the non-dismissible dialog is shown on the fire');
    expect(find.text('Theek hai'), findsOneWidget, reason: 'a single OK button');

    await tester.tap(find.text('Theek hai'));
    await _pump(tester); // dialog pops + signOut completes

    expect(session.state, isNull,
        reason: 'OK hard-logs-out via AppSessionCubit.signOut()');
    expect(locator<PayerTokenStore>().hasSession, isFalse,
        reason: 'the bearer is wiped from the store');
    expect(find.text('Account nahi mila'), findsNothing,
        reason: 'the dialog is gone after OK');
  });

  testWidgets('a second fire while the dialog is up shows only ONE dialog',
      (WidgetTester tester) async {
    tester.view.physicalSize = const Size(800, 1600);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);

    await tester.pumpWidget(const PayerApp());
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

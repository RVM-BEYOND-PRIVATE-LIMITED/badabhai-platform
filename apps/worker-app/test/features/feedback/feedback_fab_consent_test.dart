// The floating Feedback button against the REAL router redirect and the REAL
// consent gate — not the pure predicate, the whole thing wired together.
//
// The defect this pins is not a 403. With `consentAccepted == false` the
// top-level `_authRedirect` bounces every push to /feedback straight back to
// /consent, so the worker taps a button that is right there in front of them and
// NOTHING VISIBLY HAPPENS: no screen, no error, no explanation. That is the
// worst failure this app can show someone who is not habituated to apps — it
// teaches them the app is broken and tells them nothing.
//
// The pure predicate is tested in feedback_fab_test.dart. This file exists
// because the predicate alone proves nothing: the overlay still has to READ the
// live auth state and rebuild on it, and that adapter is where a "fixed" button
// stays dead.
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
import 'package:badabhai_worker_app/features/feedback/presentation/feedback_screen.dart';
import 'package:badabhai_worker_app/features/resume/presentation/cubit/resume_cubit.dart';

import '../../core/auth/fakes.dart';

/// A MockAuthApi whose pinVerify returns a scripted TD62 `consent_accepted`.
class _ScriptedConsentApi extends MockAuthApi {
  _ScriptedConsentApi(super.tokenStore);

  bool? consentAccepted;

  @override
  Future<PinVerifyResult> pinVerify(String pin,
      {required String refreshToken}) async {
    final PinVerifyResult result =
        await super.pinVerify(pin, refreshToken: refreshToken);
    return PinVerifyResult(
      tokens: result.tokens,
      consentAccepted: consentAccepted,
    );
  }
}

Future<_ScriptedConsentApi> _wire({required bool? consentAccepted}) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  await locator.reset();
  setupLocator(apiClient: MockApiClient(), secureStore: FakeSecureStore());
  final SecureTokenStore store = locator<SecureTokenStore>();
  await store.writeRefreshToken('remembered-refresh');
  await store.writeWorkerId('worker-7');
  await store.writePinSet(true);
  final _ScriptedConsentApi api = _ScriptedConsentApi(store)
    ..consentAccepted = consentAccepted;
  await initAuthLocator(
    localeStore: LocaleStore(FakePrefs()),
    authApi: api,
    persistentAuthEnabled: true,
  );
  await locator<AuthSessionManager>().bootstrap();
  return api;
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

void main() {
  // MockApiClient.getResumeDocument() deliberately always answers
  // `document: null` (see its own doc) — collapsed to a single attempt so
  // landing on the shell (Resume tab included) does not leave a real
  // pending Timer past this file's fixed pump sequences (see
  // ResumeCubit.documentPollInterval's own doc).
  setUpAll(() {
    ResumeCubit.documentPollMaxAttempts = 1;
    ResumeCubit.documentPollInterval = Duration.zero;
  });
  tearDownAll(() {
    ResumeCubit.documentPollMaxAttempts = 6;
    ResumeCubit.documentPollInterval = const Duration(seconds: 2);
  });

  tearDown(() async => locator.reset());

  void bigCanvas(WidgetTester tester) {
    tester.view.physicalSize = const Size(900, 1900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
  }

  testWidgets(
      'consent_accepted=false: the Feedback button is GONE, not dead — the '
      'router would bounce its push back to /consent',
      (WidgetTester tester) async {
    bigCanvas(tester);
    await _wire(consentAccepted: false);
    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));
    await _enterPin(tester, '7416');
    await _pumpUntil(tester, find.text('Your privacy'));

    // On the consent gate — the only route reachable in this state.
    expect(find.text('Your privacy'), findsOneWidget);
    expect(find.text('Feedback'), findsNothing,
        reason: 'a button whose push the router swallows must not be offered');
  });

  testWidgets(
      'the tri-state UNKNOWN keeps the button: an older server must not cost '
      'every worker their way to report a problem',
      (WidgetTester tester) async {
    bigCanvas(tester);
    await _wire(consentAccepted: null);
    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));
    await _enterPin(tester, '7416');
    await _pumpUntil(tester, find.text('Your resume'));

    expect(find.text('Feedback'), findsOneWidget);

    // Settle the ResumePhotoHeader's best-effort resume-fields fetch (ADR-0032,
    // mock latency 300ms) AND the resume document fetch (#1398 —
    // showGenerated()'s awaitingDocument window, documentPollMaxAttempts=1
    // so exactly one 300ms mock call) so no timer outlives the test.
    await tester.pump(const Duration(milliseconds: 700));
    await tester.pump(const Duration(milliseconds: 700));
  });

  testWidgets('consent_accepted=true shows it on the shell', (
    WidgetTester tester,
  ) async {
    bigCanvas(tester);
    await _wire(consentAccepted: true);
    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));
    await _enterPin(tester, '7416');
    await _pumpUntil(tester, find.text('Your resume'));

    expect(find.text('Feedback'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 700));
    await tester.pump(const Duration(milliseconds: 700));
  });

  // The overlay has held the current route in `_path` since it was written and
  // threw it away on tap, so an admin reading "button kaam nahi kar raha" had no
  // way to tell WHICH button. This is the whole plumbing end to end: the tap
  // carries the live route, the route table reads it back, and the screen holds
  // it until submit.
  testWidgets('tapping Feedback carries the route the worker was ON', (
    WidgetTester tester,
  ) async {
    bigCanvas(tester);
    await _wire(consentAccepted: true);
    await tester.pumpWidget(const BadaBhaiApp());
    await _pumpUntil(tester, find.text('PIN daalein'));
    await _enterPin(tester, '7416');
    await _pumpUntil(tester, find.text('Your resume'));
    await tester.pump(const Duration(milliseconds: 700));
    await tester.pump(const Duration(milliseconds: 700));

    await tester.tap(find.text('Feedback'));
    await tester.pumpAndSettle();

    expect(find.byType(FeedbackScreen), findsOneWidget,
        reason: 'with consent given the push is not redirected');
    expect(
      tester.widget<FeedbackScreen>(find.byType(FeedbackScreen)).fromRoute,
      '/resume',
    );
  });
}

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
import 'package:go_router/go_router.dart';
import 'package:google_fonts/google_fonts.dart';

import 'package:badabhai_worker_app/app.dart';
import 'package:badabhai_worker_app/router.dart';
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
  Future<PinVerifyResult> pinVerify(
    String pin, {
    required String refreshToken,
  }) async {
    final PinVerifyResult result = await super.pinVerify(
      pin,
      refreshToken: refreshToken,
    );
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

Future<void> _pumpUntil(
  WidgetTester tester,
  Finder finder, {
  int maxFrames = 50,
}) async {
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
    await tester.tap(
      find.descendant(of: find.byType(BbPinKeypad), matching: find.text(d)),
    );
    await tester.pump();
  }
}

/// The route these tests step onto to see the pill, and why it is this one.
///
/// The three tab roots (/jobs, /resume, /profile) no longer carry the floating
/// pill: their `KitTabHeader` owns the Feedback action itself (R2), so the
/// overlay would be a duplicate control sitting over the bottom nav. The
/// overlay's live-auth wiring still has to be proven, so these tests step one
/// route deeper — onto a screen with no header Feedback of its own.
///
/// It is reached with `push`, because that is how the app itself navigates:
/// every screen under a tab is pushed onto it.
///
/// And that is exactly what the overlay's route source has to survive. It
/// resolves the route from `routerDelegate.currentConfiguration` (see its own
/// doc: the RESOLVED match list, so a refreshListenable redirect is tracked) —
/// but from the TOP-MOST match, not from `uri`. An IMPERATIVE PUSH does not
/// change `uri`: pushing `/invite` renders the Invite screen while `uri.path`
/// still reads `/resume`. Reading `uri.path` therefore judged every pushed
/// screen by the tab root it was pushed from, and since the tab roots are
/// hidden (R2), that stripped the pill from `/resume/edit`,
/// `/profile/settings`, `/jobs/search`, `/devices` and `/alerts` — none of
/// which has a header Feedback action of its own. A test that navigated with
/// `go` here would prove the pill on a route the worker never arrives at that
/// way.
const String _kShownRoute = Routes.invite;

/// PUSHES [_kShownRoute] through the REAL router, from the landing screen.
Future<void> _pushShownRoute(WidgetTester tester) async {
  final GoRouter router = GoRouter.of(tester.element(find.text('Your resume')));
  router.push(_kShownRoute);
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  // The overlay defers its rebuild to a POST-FRAME callback (the router
  // delegate can notify mid-build), so the new route needs one more frame to
  // reach the button than the navigation itself does.
  await tester.pump(const Duration(milliseconds: 400));

  // Pin the values the overlay actually reads: a missing pill after this means
  // the predicate or the rebuild, never the navigation.
  final RouteMatchList config = router.routerDelegate.currentConfiguration;
  expect(
    config.lastOrNull?.matchedLocation,
    _kShownRoute,
    reason: 'the overlay reads the TOP-MOST match, so a PUSH counts',
  );
  expect(
    config.uri.path,
    Routes.resume,
    reason:
        'and the shell location still reads the tab root — reading THIS '
        'is what hid the pill on every pushed screen',
  );
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
      await _pumpUntil(tester, find.text('YOUR PRIVACY'));

      // On the consent gate (the kit's 'YOUR PRIVACY' top bar) — the only route
      // reachable in this state.
      expect(find.text('YOUR PRIVACY'), findsOneWidget);
      expect(
        find.text('Feedback'),
        findsNothing,
        reason: 'a button whose push the router swallows must not be offered',
      );
    },
  );

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

      // The Resume TAB itself no longer carries the floating pill — its header
      // owns the Feedback action (R2).
      expect(find.text('Feedback'), findsNothing);

      // Settle the resume profile card's best-effort resume-fields fetch (ADR-0032,
      // mock latency 300ms) AND the resume document fetch (#1398 —
      // showGenerated()'s awaitingDocument window, documentPollMaxAttempts=1
      // so exactly one 300ms mock call) so no timer outlives the test.
      await tester.pump(const Duration(milliseconds: 700));
      await tester.pump(const Duration(milliseconds: 700));

      await _pushShownRoute(tester);
      expect(find.text('Feedback'), findsOneWidget);
    },
  );

  testWidgets('consent_accepted=true shows it on a pushed route', (
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

    await _pushShownRoute(tester);
    expect(find.text('Feedback'), findsOneWidget);
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
    await _pushShownRoute(tester);

    await tester.tap(find.text('Feedback'));
    await tester.pumpAndSettle();

    expect(
      find.byType(FeedbackScreen),
      findsOneWidget,
      reason: 'with consent given the push is not redirected',
    );
    expect(
      tester.widget<FeedbackScreen>(find.byType(FeedbackScreen)).fromRoute,
      _kShownRoute,
      reason: 'the tap must carry the route the worker was actually ON',
    );
  });
}

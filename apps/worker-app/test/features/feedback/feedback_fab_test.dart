import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import 'package:badabhai_worker_app/core/widgets/feedback_fab.dart';
import 'package:badabhai_worker_app/router.dart';
import 'package:badabhai_worker_app/features/auth/presentation/widgets/bb_pin_view.dart';

/// The floating Feedback button hides on the MINIMUM set: the pre-login auth
/// screens (login, OTP, PIN — no session token yet), the splash, the feedback
/// page itself (anti-stack), and the screens that carry their own Feedback
/// action (chat routes, the name step). It shows everywhere else the worker is
/// logged in, including the consent onboarding step.
void main() {
  // #1466 — the unlock row now carries a BLINKING caret, and a perpetual blink
  // keeps a frame scheduled forever, so every `pumpAndSettle` below would pump
  // until it timed out. Freeze it, exactly as Flutter's own
  // `EditableText.debugDeterministicCursor` exists to be frozen.
  setUpAll(() => BbPinView.debugDeterministicCaret = true);
  tearDownAll(() => BbPinView.debugDeterministicCaret = false);

  group('showFeedbackOn', () {
    test('hidden on splash, the pre-login auth screens, chat routes, the name '
        'step, building, voice, and self', () {
      for (final String path in <String>[
        '/', // splash
        Routes.phoneLogin,
        Routes.otpVerify,
        Routes.pin,
        Routes.setPin, // '/pin/set' — covered by the '/pin' prefix
        Routes.forgotPin, // '/pin/forgot'
        Routes.feedback, // don't offer feedback from the feedback page
        Routes.chatProfiling, // header owns Feedback here instead
        Routes.badaBhai, // same screen, same reason
        Routes.name, // bottom bar owns a Feedback pill here instead
        Routes.building, // spec §3.22: the build screen has no feedback button
        Routes.voiceNote, // would cover the record control at 320dp
      ]) {
        expect(showFeedbackOn(path), isFalse, reason: 'must hide on $path');
      }
    });

    test(
      'hidden on the three TAB ROOTS, whose header carries Feedback itself',
      () {
        // R2 — the tab header's yellow chat glyph IS the Feedback action (spec
        // §4). The floating pill on the same screen would be a second, identical
        // control, and the one that sits over the bottom nav.
        for (final String path in <String>[
          Routes.jobs,
          Routes.resume,
          Routes.profile,
        ]) {
          expect(showFeedbackOn(path), isFalse, reason: 'must hide on $path');
        }
      },
    );

    test('the tab roots are matched EXACTLY, so pushed routes under them keep '
        'the pill', () {
      // These screens have no header Feedback action of their own, so a prefix
      // rule here would strip the only way to report a problem from most of
      // the app.
      for (final String path in <String>[
        Routes.jobSearch, // /jobs/search
        '/jobs/detail/job-1',
        Routes.appliedJobs,
        Routes.resumeEdit, // /resume/edit
        Routes.settings, // /profile/settings
        Routes.kit, // /profile/kit
        Routes.devices,
      ]) {
        expect(showFeedbackOn(path), isTrue, reason: 'must show on $path');
      }
    });

    test('shown across the logged-in app (incl. consent onboarding)', () {
      for (final String path in <String>[
        Routes.consent,
        Routes.resumeUpload,
        Routes.invite,
        Routes.alerts,
      ]) {
        expect(showFeedbackOn(path), isTrue, reason: 'must show on $path');
      }
    });

    test(
      'the /pin prefix does not swallow an unrelated /pinboard-like route',
      () {
        // Guard the prefix rule: only /pin and /pin/* are auth, not a route that
        // merely starts with the letters "pin".
        expect(showFeedbackOn('/pinned-jobs'), isTrue);
      },
    );
  });

  /// The consent arm. `_authRedirect` bounces ANY push to /feedback back to
  /// /consent while the tri-state is a definitive `false`, so the button is not
  /// merely restricted there — tapping it does nothing visible at all. The
  /// principle this file already states ("a dead button is worse than no
  /// button") simply had not been carried to that state.
  group('showFeedbackOn — the consent gate', () {
    test('a definitive false hides it, including on /consent itself', () {
      for (final String path in <String>[
        Routes.consent, // the only route reachable in that state
        Routes.resumeEdit,
        Routes.settings,
        Routes.resumeUpload,
      ]) {
        expect(
          showFeedbackOn(path, consentAccepted: false),
          isFalse,
          reason: 'the router would swallow a push from $path',
        );
      }
    });

    test('true and the tri-state UNKNOWN both still show it', () {
      // null = an older server that never sent `consent_accepted`. The push is
      // NOT redirected then, and the screen handles the server's own 403 with
      // something the worker can act on — hiding here would delete feedback for
      // every worker on an older API to dodge an error that may never come.
      for (final bool? signal in <bool?>[true, null]) {
        expect(
          showFeedbackOn(Routes.resumeEdit, consentAccepted: signal),
          isTrue,
          reason: 'consentAccepted: $signal',
        );
      }
    });

    test('consent never RE-shows it on a route that is hidden anyway', () {
      expect(showFeedbackOn(Routes.phoneLogin, consentAccepted: true), isFalse);
      expect(showFeedbackOn(Routes.feedback, consentAccepted: true), isFalse);
      expect(showFeedbackOn('/', consentAccepted: true), isFalse);
    });
  });

  /// The adapter that decides whether the gate is even live. It reports a signal
  /// ONLY under the exact conditions `_authRedirect` requires before it will
  /// redirect at all — anything else and the button is left alone.
  group('feedbackConsentSignal', () {
    test(
      'no auth graph wired -> null (legacy widget tests stay unchanged)',
      () {
        expect(feedbackConsentSignal(null), isNull);
      },
    );
  });

  group('FeedbackFabInset — the pill reserves its own band', () {
    testWidgets('a page with no overlay above it reserves NOTHING', (
      WidgetTester tester,
    ) async {
      double? seen;
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (BuildContext context) {
              seen = FeedbackFabInset.of(context);
              return const SizedBox.shrink();
            },
          ),
        ),
      );
      // Every isolated widget test, and any host that mounts no pill.
      expect(seen, 0);
    });

    testWidgets('a page under the overlay pads for the pill, and the pill '
        'never lands on the reserved content', (WidgetTester tester) async {
      tester.view.physicalSize = const Size(320, 568);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final GoRouter router = GoRouter(
        initialLocation: Routes.invite,
        routes: <RouteBase>[
          GoRoute(
            path: Routes.invite,
            builder: (BuildContext context, GoRouterState state) => Scaffold(
              body: SingleChildScrollView(
                padding: EdgeInsets.only(
                  bottom: FeedbackFabInset.of(context),
                ),
                child: const SizedBox(height: 2000, child: Text('last')),
              ),
            ),
          ),
          GoRoute(
            path: Routes.feedback,
            builder: (_, __) => const Scaffold(body: Text('FEEDBACK')),
          ),
        ],
      );
      await tester.pumpWidget(
        MaterialApp.router(
          routerConfig: router,
          builder: (BuildContext context, Widget? child) => FeedbackFabOverlay(
            router: router,
            child: child ?? const SizedBox.shrink(),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // The pill is up, and the page has been told how much room it takes.
      final Finder pill = find.text('Feedback');
      expect(pill, findsOneWidget);
      final Rect pillBox = tester.getRect(
        find.ancestor(of: pill, matching: find.byType(Material)).first,
      );
      final ScrollableState scroll = tester.state<ScrollableState>(
        find.byType(Scrollable),
      );
      // Scrolled to the very end, the reserved band is EMPTY canvas: the
      // content's own bottom edge stops above the pill. Before the reserve
      // existed the pill sat on the last control of a dozen screens — and on
      // the DPDP consent tick, which is the last child of its scroll view and
      // so could not be scrolled clear at all.
      scroll.position.jumpTo(scroll.position.maxScrollExtent);
      await tester.pump();
      expect(
        tester.getRect(find.text('last')).bottom,
        lessThanOrEqualTo(pillBox.top + 0.5),
        reason: 'the pill is painted over the page content',
      );
    });
  });
}

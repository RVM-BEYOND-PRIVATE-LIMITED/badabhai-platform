import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/widgets/feedback_fab.dart';
import 'package:badabhai_worker_app/router.dart';

/// The floating Feedback button hides on the MINIMUM set: the pre-login auth
/// screens (login, OTP, PIN — no session token yet), the splash, the feedback
/// page itself (anti-stack), and the two `ChatProfilingScreen` routes (which
/// put their own Feedback action in the header instead). It shows everywhere
/// else the worker is logged in, including the consent + name onboarding
/// steps.
void main() {
  group('showFeedbackOn', () {
    test(
        'hidden on splash, the pre-login auth screens, self (anti-stack), '
        'and the two chat routes (header owns Feedback there)', () {
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
      ]) {
        expect(showFeedbackOn(path), isFalse, reason: 'must hide on $path');
      }
    });

    test('shown across the logged-in app (incl. consent + name onboarding)', () {
      for (final String path in <String>[
        Routes.consent,
        Routes.name,
        Routes.jobs,
        Routes.resume,
        Routes.profile,
        Routes.voiceNote,
        Routes.invite,
        Routes.alerts,
        Routes.jobSearch,
        '/jobs/detail/job-1',
        Routes.resumeEdit,
        Routes.settings,
        Routes.appliedJobs,
      ]) {
        expect(showFeedbackOn(path), isTrue, reason: 'must show on $path');
      }
    });

    test('the /pin prefix does not swallow an unrelated /pinboard-like route',
        () {
      // Guard the prefix rule: only /pin and /pin/* are auth, not a route that
      // merely starts with the letters "pin".
      expect(showFeedbackOn('/pinned-jobs'), isTrue);
    });
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
        Routes.resume,
        Routes.jobs,
        Routes.name,
      ]) {
        expect(showFeedbackOn(path, consentAccepted: false), isFalse,
            reason: 'the router would swallow a push from $path');
      }
    });

    test('true and the tri-state UNKNOWN both still show it', () {
      // null = an older server that never sent `consent_accepted`. The push is
      // NOT redirected then, and the screen handles the server's own 403 with
      // something the worker can act on — hiding here would delete feedback for
      // every worker on an older API to dodge an error that may never come.
      for (final bool? signal in <bool?>[true, null]) {
        expect(showFeedbackOn(Routes.resume, consentAccepted: signal), isTrue,
            reason: 'consentAccepted: $signal');
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
    test('no auth graph wired -> null (legacy widget tests stay unchanged)', () {
      expect(feedbackConsentSignal(null), isNull);
    });
  });
}

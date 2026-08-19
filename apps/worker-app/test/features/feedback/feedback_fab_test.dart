import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/core/widgets/feedback_fab.dart';
import 'package:badabhai_worker_app/router.dart';

/// The floating Feedback button hides on the MINIMUM set: the pre-login auth
/// screens (login, OTP, PIN — no session token yet), the splash, and the feedback
/// page itself (anti-stack). It shows everywhere the worker is logged in,
/// including the consent + name onboarding steps.
void main() {
  group('showFeedbackOn', () {
    test('hidden on splash, the pre-login auth screens, and self (anti-stack)',
        () {
      for (final String path in <String>[
        '/', // splash
        Routes.phoneLogin,
        Routes.otpVerify,
        Routes.pin,
        Routes.setPin, // '/pin/set' — covered by the '/pin' prefix
        Routes.forgotPin, // '/pin/forgot'
        Routes.feedback, // don't offer feedback from the feedback page
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
        Routes.badaBhai,
        Routes.profile,
        Routes.chatProfiling,
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
}

import 'dart:async';

import 'package:badabhai_worker_app/core/consent/voice_consent.dart';
import 'package:badabhai_worker_app/core/widgets/role_art/role_art.dart';
import 'package:badabhai_worker_app/features/chat/presentation/widgets/resume_action_button.dart';

/// Suite-wide harness (flutter_test picks this file up for every test below
/// `test/`). The job cards' role illustrations and the résumé action's ripple
/// loop forever, which would hold every `pumpAndSettle` open; they paint their
/// rest pose here instead. The tests that exercise the motion switch it back on.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  debugRoleArtAnimationsEnabled = false;
  debugResumeActionAnimationEnabled = false;
  // OWNER ASK (2026-10-22) — the app hides voice until it KNOWS the worker
  // gave voice consent (fail closed). Suites written before that switch test
  // a consenting worker, so an unknown answer reads as granted here; the
  // voice-consent tests set it back to false to prove the app's default.
  VoiceConsent.debugUnknownMeansGranted = true;
  await testMain();
}

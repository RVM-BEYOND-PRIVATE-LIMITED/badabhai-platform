import 'dart:async';

import 'package:badabhai_worker_app/core/widgets/role_art/role_art.dart';
import 'package:badabhai_worker_app/features/chat/presentation/widgets/resume_action_button.dart';

/// Suite-wide harness (flutter_test picks this file up for every test below
/// `test/`). The job cards' role illustrations and the résumé action's ripple
/// loop forever, which would hold every `pumpAndSettle` open; they paint their
/// rest pose here instead. The tests that exercise the motion switch it back on.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  debugRoleArtAnimationsEnabled = false;
  debugResumeActionAnimationEnabled = false;
  await testMain();
}

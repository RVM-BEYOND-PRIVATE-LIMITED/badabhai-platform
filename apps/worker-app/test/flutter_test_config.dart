import 'dart:async';

import 'package:badabhai_worker_app/core/widgets/role_art/role_art.dart';

/// Suite-wide harness (flutter_test picks this file up for every test below
/// `test/`). The job cards' role illustrations loop forever, which would hold
/// every `pumpAndSettle` open; they paint their rest pose here instead. The
/// role-art tests switch the motion back on to exercise it.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  debugRoleArtAnimationsEnabled = false;
  await testMain();
}

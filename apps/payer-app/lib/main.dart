import 'package:flutter/material.dart';

import 'app.dart';
import 'core/auth/payer_token_store.dart';
import 'core/di/locator.dart';
import 'core/observability/crash_reporter.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  setupLocator();
  // Hydrate the persisted bearer from secure storage BEFORE the first frame so
  // AppSessionCubit.bootstrap() can restore a live session on cold start (the
  // session survives an app kill instead of dead-ending at Login). This is a
  // bounded local Keystore read — the three keys are read concurrently (see
  // PayerTokenStore.load) so it is one round-trip, not three.
  await locator<PayerTokenStore>().load();

  runApp(const PayerApp());

  // Crash reporting comes up AFTER the first frame (#379) — never before it.
  // It is fail-closed but not fast: it awaits native Firebase init, which on a
  // non-GMS / AOSP ROM can hang until its 8s timeout instead of erroring. Doing
  // that ahead of runApp froze the payer on the static native splash for up to
  // 8s on EVERY cold start. Deferred, it costs no crash coverage: init installs
  // the Dart error handlers before it awaits Firebase and buffers anything
  // raised in the gap. Not awaited — it never throws.
  CrashReporter.initAfterFirstFrame(appName: 'payer-app', ownPackage: 'payer_app');
}

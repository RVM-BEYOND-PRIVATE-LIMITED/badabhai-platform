import 'package:flutter/material.dart';

import 'app.dart';
import 'core/di/locator.dart';
import 'core/observability/crash_reporter.dart';
import 'features/auth/domain/auth_session_manager.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Wire the synchronous, plugin-free graph, then the async auth singletons
  // (LocaleStore + AuthApi + AuthSessionManager). The latter MUST be awaited
  // before the first authed request and before the router reads the manager.
  //
  // #315: this await is also what makes the UI language work. BadaBhaiApp reads
  // LocaleStore ONCE in initState to pick its Locale, so the store has to be
  // registered before runApp below — skip the await and every worker silently
  // gets the Hindi default no matter what they chose.
  setupLocator();
  await initAuthLocator();

  // Resolve the cold-start auth state once (remembered refresh token → locked →
  // PIN; none → loggedOut → phone) BEFORE the first frame, so the router's
  // redirect routes correctly from app open. This is a local Keystore read —
  // bounded, and the router's first redirect is wrong without it.
  await locator<AuthSessionManager>().bootstrap();

  runApp(const BadaBhaiApp());

  // Crash reporting comes up AFTER the first frame (#379) — never before it.
  // It is fail-closed but not fast: it awaits native Firebase init, which on a
  // non-GMS / AOSP ROM can hang until its 8s timeout instead of erroring. Doing
  // that ahead of runApp froze the worker on the static native splash for ~8s
  // on EVERY cold start. Deferred, it costs no crash coverage: init installs
  // the Dart error handlers before it awaits Firebase and buffers anything
  // raised in the gap. Not awaited — it never throws.
  CrashReporter.initAfterFirstFrame(
    appName: 'worker-app',
    ownPackage: 'badabhai_worker_app',
  );
}

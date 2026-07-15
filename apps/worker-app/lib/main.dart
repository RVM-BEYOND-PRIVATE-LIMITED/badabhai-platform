import 'package:flutter/material.dart';

import 'app.dart';
import 'core/di/locator.dart';
import 'core/observability/crash_reporter.dart';
import 'features/auth/domain/auth_session_manager.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  // Crash reporting FIRST — fail-closed. On a device that can't start Firebase
  // (non-GMS / exotic ROM / bare emulator) this returns with reporting disabled
  // and the app keeps running; it never throws. Installs the Flutter + async +
  // isolate error handlers only when Crashlytics is actually available.
  await CrashReporter.init(appName: 'worker-app', ownPackage: 'badabhai_worker_app');

  // Wire the synchronous, plugin-free graph, then the async auth singletons
  // (LocaleStore + AuthApi + AuthSessionManager). The latter MUST be awaited
  // before the first authed request and before the router reads the manager.
  setupLocator();
  await initAuthLocator();

  // Resolve the cold-start auth state once (remembered refresh token → locked →
  // PIN; none → loggedOut → phone) BEFORE the first frame, so the router's
  // redirect routes correctly from app open.
  await locator<AuthSessionManager>().bootstrap();

  runApp(const BadaBhaiApp());
}

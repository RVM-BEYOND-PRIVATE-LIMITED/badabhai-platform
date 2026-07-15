import 'package:flutter/material.dart';

import 'app.dart';
import 'core/auth/payer_token_store.dart';
import 'core/di/locator.dart';
import 'core/observability/crash_reporter.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Crash reporting FIRST — fail-closed. Returns with reporting disabled (never
  // throws) on a device that can't start Firebase; installs the Flutter + async
  // + isolate error handlers only when Crashlytics is actually available.
  await CrashReporter.init(appName: 'payer-app', ownPackage: 'payer_app');
  setupLocator();
  // Hydrate the persisted bearer from secure storage BEFORE the first frame so
  // AppSessionCubit.bootstrap() can restore a live session on cold start (the
  // session survives an app kill instead of dead-ending at Login).
  await locator<PayerTokenStore>().load();
  runApp(const PayerApp());
}

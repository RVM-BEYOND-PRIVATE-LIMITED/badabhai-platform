import 'package:flutter/material.dart';

import 'app.dart';
import 'core/di/locator.dart';
import 'features/auth/domain/auth_session_manager.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

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

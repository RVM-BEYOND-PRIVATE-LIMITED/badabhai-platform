import 'package:flutter/material.dart';

import 'app.dart';
import 'core/auth/payer_token_store.dart';
import 'core/di/locator.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  setupLocator();
  // Hydrate the persisted bearer from secure storage BEFORE the first frame so
  // AppSessionCubit.bootstrap() can restore a live session on cold start (the
  // session survives an app kill instead of dead-ending at Login).
  await locator<PayerTokenStore>().load();
  runApp(const PayerApp());
}

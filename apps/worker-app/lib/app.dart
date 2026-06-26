import 'package:flutter/material.dart';

import 'core/theme/app_theme.dart';
import 'router.dart';

class BadaBhaiApp extends StatelessWidget {
  const BadaBhaiApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'BadaBhai',
      debugShowCheckedModeBanner: false,
      theme: AppTheme.light(),
      initialRoute: Routes.splash,
      routes: appRoutes,
    );
  }
}

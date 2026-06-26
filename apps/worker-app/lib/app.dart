import 'package:flutter/material.dart';

import 'core/config/app_config.dart';
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
      // A corner ribbon in MOCK mode so it is always obvious the backend is
      // stubbed. No effect in REAL mode (the default) — the builder stays null.
      builder: kUseMocks
          ? (BuildContext context, Widget? child) => Banner(
                message: 'MOCK',
                location: BannerLocation.topEnd,
                color: Colors.deepOrange,
                child: child ?? const SizedBox.shrink(),
              )
          : null,
    );
  }
}

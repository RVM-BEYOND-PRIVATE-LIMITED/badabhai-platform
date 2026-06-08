import 'package:flutter/material.dart';

import 'core/theme.dart';
import 'router.dart';

class BadaBhaiApp extends StatelessWidget {
  const BadaBhaiApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'BadaBhai',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(),
      initialRoute: Routes.splash,
      routes: appRoutes,
    );
  }
}

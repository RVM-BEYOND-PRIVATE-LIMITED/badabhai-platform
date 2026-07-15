import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import 'crash_reporter.dart';

/// Reports the current screen to Crashlytics on every navigation, so a crash
/// report carries the screen it happened on (e.g. `screen = /resume`).
///
/// go_router keeps shell branches alive in an IndexedStack, so a plain
/// [NavigatorObserver] misses tab switches. Listening to the router delegate
/// instead captures EVERY location change — tab switch, push, and pop — from a
/// single attach point.
///
/// Returns a detach callback; call it from the owner's `dispose`.
VoidCallback attachRouterScreenTracking(GoRouter router) {
  void report() {
    final String path = router.routerDelegate.currentConfiguration.uri.path;
    CrashReporter.setScreen(path.isEmpty ? '/' : path);
  }

  router.routerDelegate.addListener(report);
  report(); // seed the initial screen
  return () => router.routerDelegate.removeListener(report);
}

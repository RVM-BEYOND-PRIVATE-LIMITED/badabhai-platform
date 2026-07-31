import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

import 'analytics.dart';
import 'crash_reporter.dart';

/// Reports the current screen on every navigation, to BOTH sinks:
///  - Crashlytics, so a crash report carries the screen it happened on
///    (e.g. `screen = /resume`) — the RAW path, which is useful for debugging
///    and only ever contains opaque ids;
///  - Analytics (B7), as an id-FREE template (`/jobs/detail/:id`) — see
///    [BbAnalytics.setScreen]. A raw path would be both an identifier in an
///    analytics dimension and an unusable high-cardinality screen name.
///
/// go_router keeps shell branches alive in an IndexedStack, so a plain
/// [NavigatorObserver] misses tab switches. Listening to the router delegate
/// instead captures EVERY location change — tab switch, push, and pop — from a
/// single attach point. Reusing it is why B7 needs no observer of its own.
///
/// Returns a detach callback; call it from the owner's `dispose`.
VoidCallback attachRouterScreenTracking(GoRouter router) {
  void report() {
    final String path = router.routerDelegate.currentConfiguration.uri.path;
    final String screen = path.isEmpty ? '/' : path;
    CrashReporter.setScreen(screen);
    // Fire-and-forget; never throws (see rule 3 in BbAnalytics).
    unawaited(BbAnalytics.instance.setScreen(screen));
  }

  router.routerDelegate.addListener(report);
  report(); // seed the initial screen
  return () => router.routerDelegate.removeListener(report);
}

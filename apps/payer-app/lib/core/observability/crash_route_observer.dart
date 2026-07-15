import 'package:flutter/widgets.dart';

import 'crash_reporter.dart';

/// Reports the current screen to Crashlytics on every navigation, so a crash
/// report carries the screen it happened on. The payer app is `MaterialApp` +
/// `Navigator` (not go_router), so a [NavigatorObserver] is the right hook —
/// attach it via `MaterialApp.navigatorObservers`. Tab switches inside the
/// shell are reported separately by `AppShell` (they are not Navigator routes).
///
/// Only named routes are reported; an unnamed route is skipped rather than
/// overwriting a good screen name with `null`.
class CrashNavigatorObserver extends NavigatorObserver {
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    _report(route);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    if (newRoute != null) _report(newRoute);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    // Back-navigation: the screen the user returns TO is now current.
    if (previousRoute != null) _report(previousRoute);
  }

  void _report(Route<dynamic> route) {
    final String? name = route.settings.name;
    if (name != null && name.isNotEmpty) CrashReporter.setScreen(name);
  }
}

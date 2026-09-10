import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';

/// Navigation that refuses to stack the SAME screen on itself (#1474).
extension BbPushOnce on BuildContext {
  /// Like `context.push`, but a no-op when [location] is already the route on
  /// top.
  ///
  /// A worker on a cheap handset taps twice when a screen does not appear
  /// instantly, and both taps were honoured — so the same screen was pushed
  /// twice and the back button appeared not to work: it dismissed the
  /// duplicate and left them staring at what looks like the same page.
  ///
  /// A LOCATION CHECK, not a timer, because it is the honest one: the question
  /// "is this screen already open" has a real answer, and answering it also
  /// covers the case where the duplicate tap arrives late (a slow frame, a
  /// worker who came back and tapped again). A time-based guard would let a
  /// slow double-tap through and block a legitimate fast one.
  ///
  /// Returns null for the refused push, which callers that `await` a result
  /// already handle — that is the same thing a dismissed screen returns.
  Future<T?> pushOnce<T extends Object?>(String location, {Object? extra}) {
    final GoRouter router = GoRouter.of(this);
    final RouteMatchList stack = router.routerDelegate.currentConfiguration;
    // The TOP of the stack, not `stack.uri` — that one reports the BASE
    // location and does not move when a route is pushed on top of it, so
    // comparing against it never matched and every duplicate sailed through.
    final String current = stack.matches.isEmpty
        ? stack.uri.toString()
        : stack.matches.last.matchedLocation;
    // Compare the PATH, so a push differing only by query string still counts
    // as the same screen.
    if (_pathOf(current) == _pathOf(location)) {
      return Future<T?>.value(null);
    }
    return router.push<T>(location, extra: extra);
  }

  static String _pathOf(String location) => Uri.parse(location).path;
}

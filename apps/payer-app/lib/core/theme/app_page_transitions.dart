import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show PredictiveBackEvent;

import 'app_motion.dart';

/// The payer app's ONE screen transition (#2591, M3): a fade plus an
/// [AppMotion.pageSlide] (8%) horizontal slide, on [AppMotion.emphasized] in
/// and [AppMotion.easeIn] out. Shared by page routes ([BbPageTransitionsBuilder])
/// and the in-shell overlays / root switch ([BbFadeSlideSwitcher]) so every
/// screen change moves the same way. Opacity + transform only; with animations
/// disabled the child is returned as-is (no transition at all).
class BbFadeSlideTransition extends StatefulWidget {
  const BbFadeSlideTransition({
    super.key,
    required this.animation,
    required this.child,
  });

  /// 0 → 1 as the child enters; 1 → 0 as it leaves.
  final Animation<double> animation;
  final Widget child;

  @override
  State<BbFadeSlideTransition> createState() => _BbFadeSlideTransitionState();
}

class _BbFadeSlideTransitionState extends State<BbFadeSlideTransition> {
  late CurvedAnimation _curved = _curve(widget.animation);

  static CurvedAnimation _curve(Animation<double> parent) => CurvedAnimation(
        parent: parent,
        curve: AppMotion.emphasized,
        reverseCurve: AppMotion.easeIn,
      );

  static final Tween<Offset> _slide = Tween<Offset>(
    begin: const Offset(AppMotion.pageSlide, 0),
    end: Offset.zero,
  );

  @override
  void didUpdateWidget(BbFadeSlideTransition oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.animation != widget.animation) {
      _curved.dispose();
      _curved = _curve(widget.animation);
    }
  }

  @override
  void dispose() {
    _curved.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (AppMotion.reduced(context)) return widget.child;
    return FadeTransition(
      opacity: _curved,
      child: SlideTransition(
        position: _slide.animate(_curved),
        child: widget.child,
      ),
    );
  }
}

/// [PageTransitionsBuilder] for every [MaterialPageRoute] in the app — the
/// [BbFadeSlideTransition] over [AppMotion.page]. On Android it also follows
/// the system predictive-back gesture: the route's own animation is driven by
/// the swipe, so the page fades and slides away under the finger (and snaps
/// back on cancel). Needs `android:enableOnBackInvokedCallback="true"`.
class BbPageTransitionsBuilder extends PageTransitionsBuilder {
  const BbPageTransitionsBuilder({this.reduced = false});

  /// True when animations are disabled: the route's controller runs for
  /// [Duration.zero] both ways, so a pop removes the page at once instead of
  /// holding it (and blocking input) for [AppMotion.page].
  final bool reduced;

  @override
  Duration get transitionDuration => reduced ? Duration.zero : AppMotion.page;

  @override
  Duration get reverseTransitionDuration => transitionDuration;

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    final Widget transition =
        BbFadeSlideTransition(animation: animation, child: child);
    if (defaultTargetPlatform != TargetPlatform.android) return transition;
    return _PredictiveBackDetector(route: route, child: transition);
  }

  /// The app's [PageTransitionsTheme]: this builder on every platform.
  static const PageTransitionsTheme theme = PageTransitionsTheme(
    builders: <TargetPlatform, PageTransitionsBuilder>{
      TargetPlatform.android: BbPageTransitionsBuilder(),
      TargetPlatform.iOS: BbPageTransitionsBuilder(),
      TargetPlatform.fuchsia: BbPageTransitionsBuilder(),
      TargetPlatform.linux: BbPageTransitionsBuilder(),
      TargetPlatform.macOS: BbPageTransitionsBuilder(),
      TargetPlatform.windows: BbPageTransitionsBuilder(),
    },
  );

  /// [theme] with animations disabled: zero-duration routes on every platform.
  static const PageTransitionsTheme reducedTheme = PageTransitionsTheme(
    builders: <TargetPlatform, PageTransitionsBuilder>{
      TargetPlatform.android: BbPageTransitionsBuilder(reduced: true),
      TargetPlatform.iOS: BbPageTransitionsBuilder(reduced: true),
      TargetPlatform.fuchsia: BbPageTransitionsBuilder(reduced: true),
      TargetPlatform.linux: BbPageTransitionsBuilder(reduced: true),
      TargetPlatform.macOS: BbPageTransitionsBuilder(reduced: true),
      TargetPlatform.windows: BbPageTransitionsBuilder(reduced: true),
    },
  );
}

/// Picks [BbPageTransitionsBuilder.theme] or its reduced twin from the OS
/// "remove animations" setting. Place it ABOVE the Navigator (in
/// `MaterialApp.builder`, below the MediaQuery): routes read their duration
/// from the navigator's context.
class BbRouteMotionScope extends StatelessWidget {
  const BbRouteMotionScope({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    final PageTransitionsTheme routes = AppMotion.reduced(context)
        ? BbPageTransitionsBuilder.reducedTheme
        : BbPageTransitionsBuilder.theme;
    return Theme(
      data: Theme.of(context).copyWith(pageTransitionsTheme: routes),
      child: child,
    );
  }
}

/// Forwards Android predictive-back events to [route] so its animation tracks
/// the swipe (the same wiring Flutter's own predictive-back builders use).
class _PredictiveBackDetector extends StatefulWidget {
  const _PredictiveBackDetector({required this.route, required this.child});

  final PageRoute<dynamic> route;
  final Widget child;

  @override
  State<_PredictiveBackDetector> createState() =>
      _PredictiveBackDetectorState();
}

class _PredictiveBackDetectorState extends State<_PredictiveBackDetector>
    with WidgetsBindingObserver {
  bool get _enabled => widget.route.isCurrent && widget.route.popGestureEnabled;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  bool handleStartBackGesture(PredictiveBackEvent backEvent) {
    if (backEvent.isButtonEvent || !_enabled) return false;
    widget.route.handleStartBackGesture(progress: 1 - backEvent.progress);
    return true;
  }

  @override
  void handleUpdateBackGestureProgress(PredictiveBackEvent backEvent) {
    widget.route.handleUpdateBackGestureProgress(
      progress: 1 - backEvent.progress,
    );
  }

  @override
  void handleCancelBackGesture() => widget.route.handleCancelBackGesture();

  @override
  void handleCommitBackGesture() => widget.route.handleCommitBackGesture();

  @override
  Widget build(BuildContext context) => widget.child;
}

/// An [AnimatedSwitcher] that moves between full-screen children with the
/// [BbFadeSlideTransition] over [AppMotion.page] — the splash → login → app
/// switch at the root. Give each child a distinct [Key]. Zero duration when
/// animations are disabled.
class BbFadeSlideSwitcher extends StatelessWidget {
  const BbFadeSlideSwitcher({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: AppMotion.resolve(context, AppMotion.page),
      // The curves live inside BbFadeSlideTransition.
      transitionBuilder: (Widget child, Animation<double> animation) =>
          BbFadeSlideTransition(animation: animation, child: child),
      layoutBuilder: (Widget? current, List<Widget> previous) => Stack(
        fit: StackFit.expand,
        children: <Widget>[...previous, if (current != null) current],
      ),
      child: child,
    );
  }
}

import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart' show HorizontalDragGestureRecognizer;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show PredictiveBackEvent;

import 'app_motion.dart';

/// The payer app's ONE screen transition (#2591, M3): a fade plus an
/// [AppMotion.pageSlide] (8%) horizontal slide, on [AppMotion.emphasized] in
/// and [AppMotion.easeIn] out. Shared by page routes ([BbPageTransitionsBuilder])
/// and the in-shell overlays / root switch ([BbFadeSlideSwitcher]) so every
/// screen change moves the same way. Opacity + transform only; with animations
/// disabled it holds at fully shown (opacity 1, no offset) in the SAME widget
/// shape, so flipping the OS setting never remounts — and so never resets —
/// the child (an open Post form, the shell's tab).
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

  static const Animation<Offset> _still =
      AlwaysStoppedAnimation<Offset>(Offset.zero);

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
    final bool reduced = AppMotion.reduced(context);
    return FadeTransition(
      opacity: reduced ? kAlwaysCompleteAnimation : _curved,
      child: SlideTransition(
        position: reduced ? _still : _slide.animate(_curved),
        child: widget.child,
      ),
    );
  }
}

/// [PageTransitionsBuilder] for every [MaterialPageRoute] in the app — the
/// [BbFadeSlideTransition] over [AppMotion.page]. On Android it also follows
/// the system predictive-back gesture: the route's own animation is driven by
/// the swipe, so the page fades and slides away under the finger (and snaps
/// back on cancel). Needs `android:enableOnBackInvokedCallback="true"`. iOS has
/// no system back button, so there a left-edge swipe drives the same route
/// animation (the swipe Cupertino routes give every page).
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
    return switch (defaultTargetPlatform) {
      TargetPlatform.android =>
        _PredictiveBackDetector(route: route, child: transition),
      TargetPlatform.iOS =>
        _EdgeSwipeBackDetector(route: route, child: transition),
      _ => transition,
    };
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

/// iOS edge swipe-back: a horizontal drag that starts in the leading-edge strip
/// drives [route]'s animation through the same back-gesture API as
/// [_PredictiveBackDetector], so the page fades + slides away under the finger.
/// Strip width and release rules match Cupertino's own detector: past half the
/// width, or a fling toward the trailing edge, pops; anything else snaps back.
class _EdgeSwipeBackDetector extends StatefulWidget {
  const _EdgeSwipeBackDetector({required this.route, required this.child});

  final PageRoute<dynamic> route;
  final Widget child;

  @override
  State<_EdgeSwipeBackDetector> createState() => _EdgeSwipeBackDetectorState();
}

class _EdgeSwipeBackDetectorState extends State<_EdgeSwipeBackDetector> {
  /// The leading-edge strip that starts the swipe (wider under a notch).
  static const double _edgeWidth = 20;

  /// Screen widths per second above which the release direction decides.
  static const double _minFlingVelocity = 1;

  late final HorizontalDragGestureRecognizer _recognizer =
      HorizontalDragGestureRecognizer(debugOwner: this)
        ..onStart = _onStart
        ..onUpdate = _onUpdate
        ..onEnd = _onEnd;

  /// The navigator of the swipe in flight; null when no swipe is.
  NavigatorState? _navigator;

  /// The route's animation under the finger: 1 = shown, 0 = gone.
  double _progress = 1;

  @override
  void dispose() {
    _recognizer.dispose();
    // Disposed mid-swipe (the route went away under the finger): release the
    // navigator's user-gesture flag the swipe set, as Cupertino does.
    final NavigatorState? navigator = _navigator;
    if (navigator != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (navigator.mounted) navigator.didStopUserGesture();
      });
    }
    super.dispose();
  }

  void _onPointerDown(PointerDownEvent event) {
    if (widget.route.isCurrent && widget.route.popGestureEnabled) {
      _recognizer.addPointer(event);
    }
  }

  void _onStart(DragStartDetails details) {
    if (!widget.route.isCurrent) return;
    _navigator = widget.route.navigator;
    _progress = 1;
    widget.route.handleStartBackGesture(progress: _progress);
  }

  void _onUpdate(DragUpdateDetails details) {
    if (_navigator == null) return;
    _progress =
        (_progress - _widthFraction(details.primaryDelta!)).clamp(0.0, 1.0);
    widget.route.handleUpdateBackGestureProgress(progress: _progress);
  }

  void _onEnd(DragEndDetails details) {
    if (_navigator == null) return;
    _navigator = null;
    final double velocity = _widthFraction(details.velocity.pixelsPerSecond.dx);
    final bool pop =
        velocity.abs() >= _minFlingVelocity ? velocity > 0 : _progress <= 0.5;
    if (pop) {
      widget.route.handleCommitBackGesture();
    } else {
      widget.route.handleCancelBackGesture();
    }
  }

  /// [dx] as a fraction of the page width, positive toward the trailing edge.
  double _widthFraction(double dx) {
    final double fraction = dx / context.size!.width;
    return Directionality.of(context) == TextDirection.rtl
        ? -fraction
        : fraction;
  }

  @override
  Widget build(BuildContext context) {
    final EdgeInsets padding = MediaQuery.paddingOf(context);
    final double inset = Directionality.of(context) == TextDirection.rtl
        ? padding.right
        : padding.left;
    return Stack(
      fit: StackFit.passthrough,
      children: <Widget>[
        widget.child,
        PositionedDirectional(
          start: 0,
          top: 0,
          bottom: 0,
          width: math.max(inset, _edgeWidth),
          child: Listener(
            onPointerDown: _onPointerDown,
            behavior: HitTestBehavior.translucent,
          ),
        ),
      ],
    );
  }
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

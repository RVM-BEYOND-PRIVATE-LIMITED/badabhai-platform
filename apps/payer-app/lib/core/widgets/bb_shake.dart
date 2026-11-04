import 'dart:math' as math;

import 'package:flutter/widgets.dart';

import '../theme/app_motion.dart';

/// Shakes its child once, on demand (#2595, M7) — the "this one" nudge a
/// refused submit gives the first invalid field: [AppMotion.shakeTravel] (6px)
/// either side of rest, one full swing over [AppMotion.shake] (200ms).
///
/// Transform only — the layout never moves — and a no-op under reduced
/// motion. Also the field's ANCHOR: a `GlobalKey<BbShakeState>` on it gives the
/// form both the context to scroll to and the [BbShakeState.shake] trigger
/// (see `BbFormErrors`).
class BbShake extends StatefulWidget {
  const BbShake({super.key, required this.child});

  final Widget child;

  /// The horizontal offset [t] (0..1) of the way through a shake: one full
  /// sine period, so it peaks at ±[AppMotion.shakeTravel] and ends at rest.
  @visibleForTesting
  static double offsetAt(double t) =>
      math.sin(t * 2 * math.pi) * AppMotion.shakeTravel;

  @override
  State<BbShake> createState() => BbShakeState();
}

class BbShakeState extends State<BbShake> with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotion.shake,
  );

  /// Shake once. Restarts a shake already running; does nothing when the OS
  /// asks for animations to be removed.
  void shake() {
    final Duration duration = AppMotion.resolve(context, AppMotion.shake);
    if (duration == Duration.zero) return;
    _controller
      ..duration = duration
      ..forward(from: 0);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, Widget? child) => Transform.translate(
        offset: Offset(
          _controller.isAnimating ? BbShake.offsetAt(_controller.value) : 0,
          0,
        ),
        child: child,
      ),
      child: widget.child,
    );
  }
}

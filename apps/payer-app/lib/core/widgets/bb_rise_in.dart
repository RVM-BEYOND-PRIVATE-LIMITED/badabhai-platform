import 'package:flutter/material.dart';

import '../theme/app_motion.dart';

/// A one-shot entrance (#2596): when mounted with [animate], [child] fades in
/// while rising [AppMotion.riseOffset] px into place over [duration], ease-out.
/// Opacity and transform only — layout is final from the first frame, so
/// nothing around it moves and input is never delayed.
///
/// [animate] is read at mount only; a rebuild never replays it, and a row
/// mounted without it costs no controller. With animations disabled the child
/// is simply there.
class BbRiseIn extends StatefulWidget {
  const BbRiseIn({
    super.key,
    required this.child,
    this.animate = true,
    this.duration = AppMotion.bubbleRise,
  });

  final Widget child;
  final bool animate;
  final Duration duration;

  @override
  State<BbRiseIn> createState() => _BbRiseInState();
}

class _BbRiseInState extends State<BbRiseIn>
    with SingleTickerProviderStateMixin {
  AnimationController? _controller;
  Animation<double>? _curve;
  bool _started = false;

  @override
  void initState() {
    super.initState();
    if (!widget.animate) return;
    final AnimationController controller =
        AnimationController(vsync: this, duration: widget.duration);
    _controller = controller;
    _curve = CurvedAnimation(parent: controller, curve: AppMotion.easeOut);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final AnimationController? controller = _controller;
    if (controller == null) return;
    controller.duration = AppMotion.resolve(context, widget.duration);
    if (_started) return;
    _started = true;
    controller.forward();
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Animation<double>? curve = _curve;
    if (curve == null) return widget.child;
    return FadeTransition(
      opacity: curve,
      child: AnimatedBuilder(
        animation: curve,
        child: widget.child,
        builder: (BuildContext context, Widget? child) => Transform.translate(
          offset: Offset(0, AppMotion.riseOffset * (1 - curve.value)),
          child: child,
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';

/// The "stamp" success mark — a green seal that lands once, like a rubber
/// stamp hitting paper. Use it on verify / unlock / apply / resume-ready
/// moments (the payer's flagship beats: a ₹40 unlock reveal, invites minted).
/// See [AppMotion.stamp].
///
/// One-shot (#2596): on mount it scales `0.6 → 1.08 → 1` over
/// [AppMotion.stampLand] — an ease-out overshoot, then a soft settle — and
/// fades in over the first part of that. Nothing loops. With animations
/// disabled it simply appears at full size.
///
/// Ported from worker-app's `BbSuccessStamp` so the "this worked" motif is
/// identical across both apps (#1077).
class BbSuccessStamp extends StatefulWidget {
  const BbSuccessStamp({
    super.key,
    this.size = 74,
    this.icon = Icons.check_rounded,
  });

  final double size;
  final IconData icon;

  /// The landing scale over the controller's 0 → 1: up to the 1.08 overshoot
  /// for the first 60%, then settling to 1.
  @visibleForTesting
  static final Animatable<double> landScale = TweenSequence<double>(
    <TweenSequenceItem<double>>[
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 0.6, end: 1.08)
            .chain(CurveTween(curve: AppMotion.easeOut)),
        weight: 60,
      ),
      TweenSequenceItem<double>(
        tween: Tween<double>(begin: 1.08, end: 1)
            .chain(CurveTween(curve: AppMotion.easeInOut)),
        weight: 40,
      ),
    ],
  );

  @override
  State<BbSuccessStamp> createState() => _BbSuccessStampState();
}

class _BbSuccessStampState extends State<BbSuccessStamp>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotion.stampLand,
  );

  late final Animation<double> _scale =
      _controller.drive(BbSuccessStamp.landScale);

  late final Animation<double> _opacity = CurvedAnimation(
    parent: _controller,
    curve: const Interval(0, 0.4, curve: AppMotion.easeOut),
  );

  bool _started = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    // The reduced-motion gate reads MediaQuery, which initState cannot.
    _controller.duration = AppMotion.resolve(context, AppMotion.stampLand);
    if (!_started) {
      _started = true;
      _controller.forward();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FadeTransition(
      opacity: _opacity,
      child: ScaleTransition(
        scale: _scale,
        child: Container(
          width: widget.size,
          height: widget.size,
          decoration: BoxDecoration(
            color: AppColors.success,
            shape: BoxShape.circle,
            boxShadow: <BoxShadow>[
              BoxShadow(
                color: AppColors.success.withValues(alpha: 0.4),
                blurRadius: 22,
                offset: const Offset(0, 8),
              ),
            ],
          ),
          child: Icon(
            widget.icon,
            size: widget.size * 0.54,
            color: AppColors.textInverse,
          ),
        ),
      ),
    );
  }
}

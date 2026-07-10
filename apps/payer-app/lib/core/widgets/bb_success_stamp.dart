import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';

/// The "stamp" success mark — a green seal that lands once, like a rubber
/// stamp hitting paper. Use it on verify / unlock / apply / resume-ready
/// moments. See `.aw-stamp` (ui.css) and [AppMotion.stamp].
///
/// One-shot: on mount it scales `0.3 → 1.0` and fades `0 → 1` over
/// [AppMotion.slow] on the [AppMotion.stamp] overshoot curve. Nothing loops.
class BbSuccessStamp extends StatefulWidget {
  const BbSuccessStamp({
    super.key,
    this.size = 74,
    this.icon = Icons.check,
  });

  final double size;
  final IconData icon;

  @override
  State<BbSuccessStamp> createState() => _BbSuccessStampState();
}

class _BbSuccessStampState extends State<BbSuccessStamp>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotion.slow,
  );

  late final Animation<double> _scale = Tween<double>(begin: 0.3, end: 1.0)
      .animate(CurvedAnimation(parent: _controller, curve: AppMotion.stamp));

  late final Animation<double> _opacity = Tween<double>(begin: 0, end: 1)
      .animate(CurvedAnimation(parent: _controller, curve: AppMotion.stamp));

  @override
  void initState() {
    super.initState();
    _controller.forward();
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
            color: AppColors.textOnBrand,
          ),
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';

/// Three dots that pulse in turn — the "a reply is on its way" cue (#2596).
///
/// A progress indicator, the one kind of motion allowed to loop, so mount it
/// ONLY while a reply is actually awaited: it loops for as long as it is in the
/// tree. Each dot animates its OPACITY only, between [_dim] and full, over one
/// [AppMotion.typingCycle]. With animations disabled the dots stand still at
/// full strength (and a widget test can settle).
class BbTypingDots extends StatefulWidget {
  const BbTypingDots({
    super.key,
    this.color = AppColors.brand,
    this.dotSize = 6,
  });

  final Color color;
  final double dotSize;

  @override
  State<BbTypingDots> createState() => _BbTypingDotsState();
}

class _BbTypingDotsState extends State<BbTypingDots>
    with SingleTickerProviderStateMixin {
  static const int _count = 3;

  /// The lowest a dot fades to (a widget opacity, not a colour tint).
  static const double _dim = 0.4;

  /// How far behind the previous dot each one runs, as a fraction of a cycle.
  static const double _lag = 0.2;

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: AppMotion.typingCycle,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (AppMotion.reduced(context)) {
      _controller
        ..stop()
        ..value = 0;
    } else if (!_controller.isAnimating) {
      _controller.repeat();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// Dot [i]'s opacity at cycle phase [t]: a rise then a fall, lagged per dot.
  double _opacity(int i, double t) {
    final double p = (t - i * _lag) % 1;
    final double wave = p < 0.5 ? p * 2 : (1 - p) * 2;
    return _dim + (1 - _dim) * wave;
  }

  @override
  Widget build(BuildContext context) {
    final bool still = AppMotion.reduced(context);
    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, Widget? _) => Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          for (int i = 0; i < _count; i++) ...<Widget>[
            if (i > 0) SizedBox(width: widget.dotSize * 0.6),
            Opacity(
              opacity: still ? 1 : _opacity(i, _controller.value),
              child: Container(
                width: widget.dotSize,
                height: widget.dotSize,
                decoration: BoxDecoration(
                  color: widget.color,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

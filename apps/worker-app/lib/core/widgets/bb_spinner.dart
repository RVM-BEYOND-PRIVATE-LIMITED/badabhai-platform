import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// BadaBhai loading spinner — spec `.aw-spin` (`ui.css` 115).
///
/// A vermilion ring (track) with a brand-coloured arc head rotating once per
/// second. Use during waits — login OTP, profile extraction, resume generation.
/// Pass [caption] to label what the worker is waiting for.
class BbSpinner extends StatefulWidget {
  const BbSpinner({super.key, this.size = 64, this.caption});

  /// Diameter of the spinner circle, in logical pixels.
  final double size;

  /// Optional waiting label rendered below the spinner, centred.
  final String? caption;

  @override
  State<BbSpinner> createState() => _BbSpinnerState();
}

class _BbSpinnerState extends State<BbSpinner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    // The 1s linear rotation period is intrinsic to a spinner — the only
    // looping motion in the system (AppMotion tokens describe one-shot motion).
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 1),
    )..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final Widget spinner = RotationTransition(
      turns: _controller,
      child: CustomPaint(
        size: Size.square(widget.size),
        painter: const _SpinnerPainter(),
      ),
    );

    if (widget.caption == null) {
      return spinner;
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        spinner,
        const SizedBox(height: AppSpacing.s4),
        Text(
          widget.caption!,
          textAlign: TextAlign.center,
          style: AppTypography.body(color: AppColors.textSecondary),
        ),
      ],
    );
  }
}

/// Paints the full vermilion track plus the brand-coloured ~90deg head arc.
class _SpinnerPainter extends CustomPainter {
  const _SpinnerPainter();

  static const double _strokeWidth = 5;

  @override
  void paint(Canvas canvas, Size size) {
    final Offset center = size.center(Offset.zero);
    final double radius = (size.shortestSide - _strokeWidth) / 2;

    final Paint track = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = _strokeWidth
      ..color = AppColors.vermilion100;
    canvas.drawCircle(center, radius, track);

    final Paint head = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = _strokeWidth
      ..strokeCap = StrokeCap.round
      ..color = AppColors.brand;
    // A quarter-turn arc, starting at the top of the circle.
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      math.pi / 2,
      false,
      head,
    );
  }

  @override
  bool shouldRepaint(_SpinnerPainter oldDelegate) => false;
}

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../theme/bb_palette.dart';
import '../theme/onboarding_theme.dart';

/// BadaBhai loading spinner: a cool hairline ring (track) with a navy arc head
/// rotating once per second.
///
/// Use during waits — login OTP, profile extraction, resume generation. Pass
/// [caption] to label what the worker is waiting for; a bare spinner tells
/// someone who is not habituated to apps nothing at all.
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
    final BbPalette p = context.bb;
    final Widget spinner = RotationTransition(
      turns: _controller,
      child: CustomPaint(
        size: Size.square(widget.size),
        painter: _SpinnerPainter(track: p.borderSubtle, head: p.textBrand),
      ),
    );

    if (widget.caption == null) {
      return spinner;
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        spinner,
        const SizedBox(height: 16),
        Text(
          widget.caption!,
          textAlign: TextAlign.center,
          style: OnboardingTypography.inter(
            size: 14,
            color: p.textSecondary,
          ),
        ),
      ],
    );
  }
}

/// Paints the full hairline track plus the navy ~90deg head arc.
class _SpinnerPainter extends CustomPainter {
  const _SpinnerPainter({required this.track, required this.head});

  final Color track;
  final Color head;

  static const double _strokeWidth = 5;

  @override
  void paint(Canvas canvas, Size size) {
    final Offset center = size.center(Offset.zero);
    final double radius = (size.shortestSide - _strokeWidth) / 2;

    final Paint trackPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = _strokeWidth
      ..color = track;
    canvas.drawCircle(center, radius, trackPaint);

    final Paint headPaint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = _strokeWidth
      ..strokeCap = StrokeCap.round
      ..color = head;
    // A quarter-turn arc, starting at the top of the circle.
    canvas.drawArc(
      Rect.fromCircle(center: center, radius: radius),
      -math.pi / 2,
      math.pi / 2,
      false,
      headPaint,
    );
  }

  @override
  bool shouldRepaint(_SpinnerPainter oldDelegate) =>
      oldDelegate.track != track || oldDelegate.head != head;
}

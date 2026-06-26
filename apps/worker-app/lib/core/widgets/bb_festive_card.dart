import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';

/// A hero card carrying the Desi-Pop **festive motif** — a double-vermilion
/// outer frame with a dashed-green inner line on crisp white paper. Reserved for
/// the few hero surfaces: the job card, the resume header, the form pop-up.
class BbFestiveCard extends StatelessWidget {
  const BbFestiveCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.s6),
    this.radius = AppRadii.lg,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(radius),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: AppColors.ink900.withValues(alpha: 0.10),
            blurRadius: 20,
            offset: const Offset(0, 8),
          ),
        ],
      ),
      child: CustomPaint(
        foregroundPainter: _FestiveBorderPainter(radius: radius),
        child: Padding(padding: padding, child: child),
      ),
    );
  }
}

class _FestiveBorderPainter extends CustomPainter {
  _FestiveBorderPainter({required this.radius});

  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint vermilion = Paint()
      ..color = AppColors.borderDouble
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    final Paint green = Paint()
      ..color = AppColors.borderFestive
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;

    // Double-vermilion outer frame.
    _strokeRRect(canvas, size, inset: 3, radius: radius - 1, paint: vermilion);
    _strokeRRect(canvas, size, inset: 6, radius: radius - 3, paint: vermilion);

    // Dashed-green inner line.
    _strokeRRect(
      canvas,
      size,
      inset: 10,
      radius: (radius - 6).clamp(2, radius),
      paint: green,
      dashed: true,
    );
  }

  void _strokeRRect(
    Canvas canvas,
    Size size, {
    required double inset,
    required double radius,
    required Paint paint,
    bool dashed = false,
  }) {
    final RRect rrect = RRect.fromRectAndRadius(
      Rect.fromLTWH(
        inset,
        inset,
        size.width - inset * 2,
        size.height - inset * 2,
      ),
      Radius.circular(radius.clamp(0, size.shortestSide / 2)),
    );
    if (!dashed) {
      canvas.drawRRect(rrect, paint);
      return;
    }
    final Path path = Path()..addRRect(rrect);
    const double dash = 7;
    const double gap = 5;
    for (final metric in path.computeMetrics()) {
      double distance = 0;
      while (distance < metric.length) {
        final double next = distance + dash;
        canvas.drawPath(
          metric.extractPath(distance, next.clamp(0, metric.length)),
          paint,
        );
        distance = next + gap;
      }
    }
  }

  @override
  bool shouldRepaint(covariant _FestiveBorderPainter oldDelegate) =>
      oldDelegate.radius != radius;
}

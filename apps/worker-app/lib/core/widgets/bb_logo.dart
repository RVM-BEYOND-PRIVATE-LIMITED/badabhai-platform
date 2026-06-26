import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// The BadaBhai app mark — a vermilion squircle holding a white chat bubble with
/// a green "lift" chevron. A Flutter port of `assets/logo/app-icon.svg` (drawn,
/// not rasterised, so it stays crisp at any size and ships zero extra assets).
///
/// Set [withWordmark] to pair it with the **BadaBhai** wordmark in Baloo 2.
class BbLogo extends StatelessWidget {
  const BbLogo({
    super.key,
    this.size = 88,
    this.withWordmark = false,
    this.wordmarkColor = AppColors.textPrimary,
  });

  final double size;
  final bool withWordmark;
  final Color wordmarkColor;

  @override
  Widget build(BuildContext context) {
    final Widget mark = SizedBox(
      width: size,
      height: size,
      child: CustomPaint(painter: _BbLogoPainter()),
    );
    if (!withWordmark) return mark;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        mark,
        const SizedBox(height: AppSpacing.s4),
        Text(
          // Brand name is always one word, two capitals.
          'BadaBhai',
          style: AppTypography.display(
            size: size * 0.42,
            weight: FontWeight.w800,
            color: wordmarkColor,
          ),
        ),
      ],
    );
  }
}

class _BbLogoPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    // The source art is authored on a 512×512 canvas; scale uniformly.
    final double k = size.width / 512.0;
    double sx(double v) => v * k;

    // Vermilion squircle.
    final RRect squircle = RRect.fromRectAndRadius(
      Rect.fromLTWH(0, 0, sx(512), sx(512)),
      Radius.circular(sx(128)),
    );
    canvas.drawRRect(squircle, Paint()..color = AppColors.brand);

    // White chat bubble + drip tail.
    final Paint white = Paint()..color = Colors.white;
    final RRect bubble = RRect.fromRectAndRadius(
      Rect.fromLTRB(sx(110), sx(124), sx(402), sx(296)),
      Radius.circular(sx(40)),
    );
    canvas.drawRRect(bubble, white);
    final Path tail = Path()
      ..moveTo(sx(150), sx(286))
      ..lineTo(sx(174), sx(360))
      ..lineTo(sx(214), sx(286))
      ..close();
    canvas.drawPath(tail, white);

    // Green "lift" chevron.
    final Paint chevron = Paint()
      ..color = AppColors.success
      ..style = PaintingStyle.stroke
      ..strokeWidth = sx(32)
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    final Path lift = Path()
      ..moveTo(sx(196), sx(268))
      ..lineTo(sx(256), sx(210))
      ..lineTo(sx(316), sx(268));
    canvas.drawPath(lift, chevron);
  }

  @override
  bool shouldRepaint(covariant _BbLogoPainter oldDelegate) => false;
}

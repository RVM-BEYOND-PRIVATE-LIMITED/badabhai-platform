import 'package:flutter/material.dart';

import '../theme/app_colors.dart';

/// The BadaBhai app mark (#2590) — a squircle holding a chat bubble with a
/// "lift" chevron. The same drawing as the worker app's `BbLogo` (a port of
/// `assets/logo/app-icon.svg`), drawn rather than rasterised so it stays crisp
/// at any size and ships zero extra assets. It replaces the stock handshake
/// icon the login header used as a logo.
///
/// Painted ONLY with existing [AppColors] tokens. The defaults suit a light
/// surface (blue squircle, white bubble, green chevron, as in the worker app);
/// on a blue surface pass [BbLogo.onBlue], which keeps the haldi chip the
/// login header always had.
class BbLogo extends StatelessWidget {
  const BbLogo({
    super.key,
    this.size = 88,
    this.squircleColor = AppColors.blue,
    this.bubbleColor = AppColors.paper,
    this.chevronColor = AppColors.green,
  });

  /// The mark for a deep-blue surface: haldi squircle, blue bubble, haldi lift.
  const BbLogo.onBlue({super.key, this.size = 88})
      : squircleColor = AppColors.haldi,
        bubbleColor = AppColors.onHaldi,
        chevronColor = AppColors.haldi;

  final double size;
  final Color squircleColor;
  final Color bubbleColor;
  final Color chevronColor;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: 'BadaBhai',
      image: true,
      child: SizedBox(
        width: size,
        height: size,
        child: CustomPaint(
          painter: _BbLogoPainter(
            squircle: squircleColor,
            bubble: bubbleColor,
            chevron: chevronColor,
          ),
        ),
      ),
    );
  }
}

class _BbLogoPainter extends CustomPainter {
  const _BbLogoPainter({
    required this.squircle,
    required this.bubble,
    required this.chevron,
  });

  final Color squircle;
  final Color bubble;
  final Color chevron;

  @override
  void paint(Canvas canvas, Size size) {
    // The source art is authored on a 512×512 canvas; scale uniformly.
    final double k = size.width / 512.0;
    double sx(double v) => v * k;

    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTWH(0, 0, sx(512), sx(512)),
        Radius.circular(sx(128)),
      ),
      Paint()..color = squircle,
    );

    // Chat bubble + drip tail.
    final Paint fill = Paint()..color = bubble;
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTRB(sx(110), sx(124), sx(402), sx(296)),
        Radius.circular(sx(40)),
      ),
      fill,
    );
    canvas.drawPath(
      Path()
        ..moveTo(sx(150), sx(286))
        ..lineTo(sx(174), sx(360))
        ..lineTo(sx(214), sx(286))
        ..close(),
      fill,
    );

    // "Lift" chevron — round caps and joins, matching the solid rounded icons.
    canvas.drawPath(
      Path()
        ..moveTo(sx(196), sx(268))
        ..lineTo(sx(256), sx(210))
        ..lineTo(sx(316), sx(268)),
      Paint()
        ..color = chevron
        ..style = PaintingStyle.stroke
        ..strokeWidth = sx(32)
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
  }

  @override
  bool shouldRepaint(covariant _BbLogoPainter oldDelegate) =>
      oldDelegate.squircle != squircle ||
      oldDelegate.bubble != bubble ||
      oldDelegate.chevron != chevron;
}

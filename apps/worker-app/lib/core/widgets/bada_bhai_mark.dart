import 'package:flutter/material.dart';

import '../theme/onboarding_theme.dart';

/// The BadaBhai two-figure mark — a smaller white worker beside a larger
/// safety-yellow one, taken from the launcher icon (one yellow man, one white
/// man). It is the GLOBAL brand glyph: every surface that shows the mark uses
/// this widget, so the drawing can never drift screen to screen.
///
/// DRAWN, NOT RASTERISED, and not an SVG runtime dependency: the app ships zero
/// image assets for the mark and has no SVG renderer, so — exactly like
/// [BbLogo]'s port of `app-icon.svg` — this is the vector port of
/// `docs/design/BadaBhai Design System/assets/logo/badabhai-mark.svg`, crisp at
/// any size. Edit that SVG and this painter together.
class BadaBhaiMark extends StatelessWidget {
  const BadaBhaiMark({
    super.key,
    this.height = 14,
    this.leadingColor = OnboardingColors.textOnBlue,
    this.trailingColor = OnboardingColors.safetyYellow,
  });

  /// Rendered height. The mark keeps the brand's 16:14 glyph box, so the width
  /// follows and the wordmark gap stays stable.
  final double height;

  /// The smaller, left-hand figure (white on the navy header).
  final Color leadingColor;

  /// The larger, right-hand figure (safety yellow).
  final Color trailingColor;

  /// The glyph's authored aspect ratio (width / height) — see the painter's
  /// 160x140 design box.
  static const double aspectRatio = 16 / 14;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: height,
      width: height * aspectRatio,
      child: CustomPaint(
        painter: _BadaBhaiMarkPainter(
          leading: leadingColor,
          trailing: trailingColor,
        ),
      ),
    );
  }
}

/// Paints the two figures on a 160x140 design box (the icon's 16:14 glyph
/// proportions). The leading figure is drawn first so the larger trailing one
/// sits in front, matching the launcher icon's overlap.
class _BadaBhaiMarkPainter extends CustomPainter {
  const _BadaBhaiMarkPainter({required this.leading, required this.trailing});

  final Color leading;
  final Color trailing;

  static const double _boxWidth = 160;
  static const double _boxHeight = 140;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    // Uniform scale (never stretch): fit the design box inside the slot and
    // centre it, so a caller that mis-sizes the box still gets a clean glyph.
    final double k = (size.width / _boxWidth) < (size.height / _boxHeight)
        ? size.width / _boxWidth
        : size.height / _boxHeight;
    canvas
      ..translate(
        (size.width - _boxWidth * k) / 2,
        (size.height - _boxHeight * k) / 2,
      )
      ..scale(k);

    _figure(
      canvas,
      head: const Offset(50, 34),
      headRadius: 22,
      body: const Rect.fromLTRB(8, 52, 90, 140),
      shoulderRadius: 40,
      color: leading,
    );
    _figure(
      canvas,
      head: const Offset(114, 26),
      headRadius: 27,
      body: const Rect.fromLTRB(54, 60, 160, 140),
      shoulderRadius: 53,
      color: trailing,
    );
  }

  /// One figure: a head circle plus a rounded-shoulder body. The body is drawn
  /// after the head and overlaps it, so the same colour reads as a single
  /// silhouette with no seam (exactly the icon's head-on-shoulders shape).
  void _figure(
    Canvas canvas, {
    required Offset head,
    required double headRadius,
    required Rect body,
    required double shoulderRadius,
    required Color color,
  }) {
    final Paint paint = Paint()..color = color;
    canvas.drawCircle(head, headRadius, paint);
    canvas.drawRRect(
      RRect.fromRectAndCorners(
        body,
        topLeft: Radius.circular(shoulderRadius),
        topRight: Radius.circular(shoulderRadius),
      ),
      paint,
    );
  }

  @override
  bool shouldRepaint(covariant _BadaBhaiMarkPainter oldDelegate) =>
      oldDelegate.leading != leading || oldDelegate.trailing != trailing;
}

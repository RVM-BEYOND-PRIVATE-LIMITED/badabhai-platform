import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../../core/theme/bb_palette.dart';

/// Test seam, in the spirit of `debugRoleArtAnimationsEnabled`: when false the
/// ripple paints its still pose and starts NO ticker, so a widget test's
/// `pumpAndSettle` is not held open by a looping animation. The suite harness
/// (`test/flutter_test_config.dart`) turns it off; a test that exercises the
/// motion turns it back on.
bool debugResumeActionAnimationEnabled = true;

/// The free-chat "Resume banayein" action: a gradient pill — dark blue to blue —
/// with a centered white label and a trailing circular arrow whose concentric
/// rings ripple outward in the brand's safety yellow on a SLOW loop.
///
/// The one resume CTA is meant to READ as the brightest thing on the screen, so
/// it wears a stronger gradient than the kit. Motion loops 2.6 s a cycle, holds
/// still under reduced motion, and is gated by [debugResumeActionAnimationEnabled]
/// so no test is held open by it.
class ResumeActionButton extends StatefulWidget {
  const ResumeActionButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.buttonKey,
  });

  final String label;

  /// Null renders the disabled (dimmed) state.
  final VoidCallback? onPressed;

  /// Key on the tappable surface, for tests.
  final Key? buttonKey;

  @override
  State<ResumeActionButton> createState() => _ResumeActionButtonState();
}

class _ResumeActionButtonState extends State<ResumeActionButton>
    with SingleTickerProviderStateMixin {
  static const Duration _period = Duration(milliseconds: 2600);
  static const double _height = 58;
  static const double _innerPad = 8;
  static const double _trailingDiameter = 42;

  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: _period,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(ResumeActionButton oldWidget) {
    super.didUpdateWidget(oldWidget);
    _sync();
  }

  bool get _shouldRun =>
      debugResumeActionAnimationEnabled &&
      !MediaQuery.disableAnimationsOf(context) &&
      widget.onPressed != null;

  void _sync() {
    if (_shouldRun) {
      if (!_controller.isAnimating) _controller.repeat();
    } else {
      _controller
        ..stop()
        ..value = 0;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final bool enabled = widget.onPressed != null;
    // The trailing circle's centre, measured in from the pill's RIGHT edge —
    // the anchor the rings expand from.
    final double trailingCentreFromRight = _innerPad + _trailingDiameter / 2;
    // A BOUNDED width: the chip row is a horizontal scroller (unbounded main
    // axis), so an intrinsic pill would fail to lay out. Kept narrower than the
    // old mock-up pill on purpose.
    final double screen = MediaQuery.sizeOf(context).width;
    final double width = screen.isFinite
        ? math.min(248.0, math.max(190.0, screen - 80))
        : 220.0;
    return Semantics(
      button: true,
      enabled: enabled,
      label: widget.label,
      child: Opacity(
        opacity: enabled ? 1 : 0.55,
        child: SizedBox(
          width: width,
          height: _height,
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              key: widget.buttonKey,
              onTap: widget.onPressed,
              borderRadius: BorderRadius.circular(_height / 2),
              splashColor: p.action.withValues(alpha: 0.28),
              highlightColor: p.action.withValues(alpha: 0.14),
              child: Container(
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(_height / 2),
                  gradient: LinearGradient(
                    begin: Alignment.centerLeft,
                    end: Alignment.centerRight,
                    colors: <Color>[p.brandSurface, p.brandSurfaceRaised],
                  ),
                  boxShadow: <BoxShadow>[
                    BoxShadow(
                      color: p.brandSurfaceRaised.withValues(alpha: 0.30),
                      blurRadius: 14,
                      offset: const Offset(0, 7),
                    ),
                  ],
                ),
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(_height / 2),
                  child: Stack(
                    children: <Widget>[
                      // Ripple rings anchored on the trailing circle.
                      Positioned.fill(
                        child: IgnorePointer(
                          child: AnimatedBuilder(
                            animation: _controller,
                            builder: (BuildContext context, Widget? _) =>
                                CustomPaint(
                                  painter: _ResumeRingPainter(
                                    progress: _controller.value,
                                    trailingCentreFromRight:
                                        trailingCentreFromRight,
                                    trailingRadius: _trailingDiameter / 2,
                                    ripple: p.action,
                                  ),
                                ),
                          ),
                        ),
                      ),
                      // The label, centered in the pill (symmetric gutters keep
                      // it off the arrow at the right).
                      Positioned.fill(
                        child: Padding(
                          padding: EdgeInsets.symmetric(
                            horizontal: _innerPad + _trailingDiameter,
                          ),
                          child: Center(
                            child: MediaQuery.withClampedTextScaling(
                              maxScaleFactor: 1.3,
                              child: FittedBox(
                                fit: BoxFit.scaleDown,
                                child: Text(
                                  widget.label,
                                  style: TextStyle(
                                    color: p.onBrandSurface,
                                    fontSize: 14,
                                    fontWeight: FontWeight.w700,
                                    letterSpacing: 0.2,
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                      Positioned(
                        right: _innerPad,
                        top: _innerPad,
                        bottom: _innerPad,
                        child: _trailingArrow(p),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _trailingArrow(BbPalette p) {
    return Container(
      width: _trailingDiameter,
      height: _trailingDiameter,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: RadialGradient(
          colors: <Color>[
            p.brandSurfaceRaised,
            p.brandSurfaceLight,
            p.brandSurface,
          ],
          stops: const <double>[0.0, 0.55, 1.0],
        ),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: p.brandSurfaceRaised.withValues(alpha: 0.40),
            blurRadius: 10,
            spreadRadius: 1,
          ),
        ],
      ),
      child: Icon(
        Icons.arrow_forward_rounded,
        color: p.onBrandSurface,
        size: 24,
      ),
    );
  }
}

/// The slow ripple: concentric safety-yellow rings expanding from the trailing
/// circle's centre and fading, painted over the gradient but under the (opaque)
/// trailing circle.
class _ResumeRingPainter extends CustomPainter {
  _ResumeRingPainter({
    required this.progress,
    required this.trailingCentreFromRight,
    required this.trailingRadius,
    required this.ripple,
  });

  final double progress;

  /// How far the ripple's centre sits IN from the pill's right edge.
  final double trailingCentreFromRight;
  final double trailingRadius;

  /// The brand action colour the rings are painted in.
  final Color ripple;

  static const int _rings = 3;

  @override
  void paint(Canvas canvas, Size size) {
    final Offset centre = Offset(
      size.width - trailingCentreFromRight,
      size.height / 2,
    );
    final double minRadius = trailingRadius;
    final double maxRadius = size.longestSide * 0.72;
    for (int i = 0; i < _rings; i++) {
      final double phase = (progress + i / _rings) % 1.0;
      final double radius = minRadius + (maxRadius - minRadius) * phase;
      final double opacity = (1 - phase) * 0.5;
      if (opacity <= 0.004) continue;
      canvas.drawCircle(
        centre,
        radius,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.0
          ..color = ripple.withValues(alpha: opacity),
      );
    }
  }

  @override
  bool shouldRepaint(_ResumeRingPainter oldDelegate) =>
      oldDelegate.progress != progress || oldDelegate.ripple != ripple;
}

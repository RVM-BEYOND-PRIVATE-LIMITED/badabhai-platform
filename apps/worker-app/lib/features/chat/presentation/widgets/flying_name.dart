import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../../../core/theme/app_motion.dart';
import '../../../../core/theme/onboarding_theme.dart';

/// ADR-0048 — the worker's freshly-entered name, flying from the chat bubble it
/// was typed in up to the header's action (which shows the name from then on).
///
/// WHY AN OVERLAY AND NOT A STACKED WIDGET. The source (a bubble in the
/// transcript) and the destination (the AppBar's trailing action) live in
/// different layout parents, and the path crosses the AppBar's edge. A widget
/// inserted in the root [Overlay] is positioned in SCREEN coordinates, so the
/// whole journey — lift-off, arc over the transcript, settle onto the button —
/// is one uninterrupted move. See [show] for how a caller starts it.
///
/// MOTION. This is a Material "hero"/container-transform moment: a single,
/// expressive, one-shot move (m3.material.io/styles/motion/transitions), so it
/// uses the **emphasized-decelerate** easing and a long duration — it leaves
/// fast and comes to a gentle rest. The token arcs upward (a quadratic Bézier,
/// not a straight line) and shrinks as it travels, so it reads as the name
/// being "lifted" off the bubble and set into the control, not as a teleport.
/// Reduced-motion is honoured by the caller: the move is skipped and the name
/// simply appears.
class FlyingName extends StatefulWidget {
  const FlyingName({
    super.key,
    required this.text,
    required this.from,
    required this.to,
    required this.onLanded,
    this.reduceMotion = false,
  });

  /// The piece of the name to fly (the part just entered).
  final String text;

  /// The source bubble's rect, in SCREEN coordinates.
  final Rect from;

  /// The destination control's rect, in SCREEN coordinates.
  final Rect to;

  /// Called once the token has landed (or immediately under reduced motion).
  /// The caller removes the overlay and reveals the name on the control.
  final VoidCallback onLanded;

  /// When true the flight is skipped and [onLanded] fires on the next frame.
  final bool reduceMotion;

  @override
  State<FlyingName> createState() => _FlyingNameState();
}

class _FlyingNameState extends State<FlyingName>
    with SingleTickerProviderStateMixin {
  /// Long enough to cross the screen and settle without feeling slow.
  static const Duration _flight = Duration(milliseconds: 620);

  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: _flight)
      ..addStatusListener((AnimationStatus status) {
        if (status == AnimationStatus.completed) widget.onLanded();
      });
    if (widget.reduceMotion) {
      // No motion for a motion-sensitive device: hand control back at once and
      // render nothing.
      WidgetsBinding.instance
          .addPostFrameCallback((_) => widget.onLanded());
    } else {
      _controller.forward();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  /// A point on the quadratic Bézier `a → c → b` at [t].
  static Offset _bezier(Offset a, Offset c, Offset b, double t) {
    final double u = 1 - t;
    return a * (u * u) + c * (2 * u * t) + b * (t * t);
  }

  @override
  Widget build(BuildContext context) {
    if (widget.reduceMotion) return const SizedBox.shrink();

    final Offset start = widget.from.center;
    final Offset end = widget.to.center;
    // Bow the path upward, scaled to the distance so it looks the same on a
    // small phone and a tablet.
    final double bow = (start - end).distance * 0.22;
    final Offset control = Offset(
      (start.dx + end.dx) / 2,
      (start.dy + end.dy) / 2 - bow.clamp(24.0, 120.0),
    );

    return AnimatedBuilder(
      animation: _controller,
      builder: (BuildContext context, Widget? child) {
        final double t =
            AppMotion.emphasizedDecelerate.transform(_controller.value);
        final Offset point = _bezier(start, control, end, t);
        // A short fade-in so the token does not pop against the bubble that is
        // still behind it, and a fade-out over the last stretch as it merges
        // into the control.
        final double opacity = _controller.value < 0.12
            ? (_controller.value / 0.12)
            : (_controller.value > 0.8
                ? (1 - (_controller.value - 0.8) / 0.2)
                : 1.0);
        final double scale = ui.lerpDouble(1.05, 0.72, t)!;
        // A small tilt that straightens as it lands.
        final double tilt = ui.lerpDouble(0.06, 0.0, t)!;
        return Positioned(
          left: point.dx,
          top: point.dy,
          child: FractionalTranslation(
            translation: const Offset(-0.5, -0.5),
            child: Opacity(
              opacity: opacity.clamp(0.0, 1.0),
              child: Transform.rotate(
                angle: tilt,
                child: Transform.scale(
                  scale: scale,
                  child: child,
                ),
              ),
            ),
          ),
        );
      },
      // Built once: the pill never changes during the flight.
      child: _FlyingPill(text: widget.text),
    );
  }
}

/// The token itself: the on-brand haldi pill the name rides up in, elevated so
/// it reads as a physical chip crossing the screen.
class _FlyingPill extends StatelessWidget {
  const _FlyingPill({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
        decoration: BoxDecoration(
          color: OnboardingColors.safetyYellow,
          borderRadius: BorderRadius.circular(999),
          boxShadow: <BoxShadow>[
            BoxShadow(
              color: Colors.black.withValues(alpha: 0.20),
              blurRadius: 18,
              offset: const Offset(0, 8),
            ),
          ],
        ),
        child: Text(
          text,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: OnboardingTypography.inter(
            size: 14,
            weight: FontWeight.w700,
            color: OnboardingColors.textOnYellow,
          ),
        ),
      ),
    );
  }
}

/// Insert a [FlyingName] into [overlay] and return a remover for it.
///
/// The single entry point the chat screen uses, so the overlay bookkeeping
/// (insert now, remove exactly once on land) lives in one place.
OverlayEntry showFlyingName({
  required OverlayState overlay,
  required String text,
  required Rect from,
  required Rect to,
  required VoidCallback onLanded,
  bool reduceMotion = false,
}) {
  late final OverlayEntry entry;
  entry = OverlayEntry(
    builder: (BuildContext context) => FlyingName(
      text: text,
      from: from,
      to: to,
      reduceMotion: reduceMotion,
      onLanded: () {
        if (entry.mounted) entry.remove();
        onLanded();
      },
    ),
  );
  overlay.insert(entry);
  return entry;
}

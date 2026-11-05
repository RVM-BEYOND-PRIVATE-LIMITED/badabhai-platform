import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_haptics.dart';
import '../theme/app_motion.dart';

/// The one tactile press for every tappable surface (#2591, M3) — CRED/NeoPOP
/// style, built in-house (no `neopop` dependency: it ships its own colour
/// system and button chrome, while all we need is a scale + an optional edge).
///
/// On press the surface scales to [AppMotion.pressScale] over
/// [AppMotion.press] and springs back on release. With [edge] a solid
/// [edgeDepth]px navy edge sits under the surface and collapses as it presses
/// down (primary buttons). Everything drops to zero duration when the OS asks
/// for animations to be removed.
///
/// Two modes:
///  - `BbPressable(onTap: …)` OWNS the tap: an [InkWell] (ripple) plus a light
///    [AppHaptics.tap]. Children must not paint an opaque [Container]
///    decoration over the ripple — use [Ink] for the surface instead.
///  - [BbPressable.passive] only ANIMATES: the child (a Material button, an
///    [InkWell]) keeps its own tap handling and haptic; the press is read from
///    the raw pointer so no gesture is stolen.
class BbPressable extends StatefulWidget {
  const BbPressable({
    super.key,
    required this.child,
    required this.onTap,
    this.haptic = true,
    this.edge = false,
    this.borderRadius = BorderRadius.zero,
  })  : enabled = onTap != null,
        _ownsTap = true;

  const BbPressable.passive({
    super.key,
    required this.child,
    this.enabled = true,
    this.edge = false,
    this.borderRadius = BorderRadius.zero,
  })  : onTap = null,
        haptic = false,
        _ownsTap = false;

  /// Depth of the navy press edge, in logical pixels.
  static const double edgeDepth = 3;

  /// Key of the navy edge layer (for widget tests).
  @visibleForTesting
  static const Key edgeKey = Key('bb_pressable_edge');

  final Widget child;
  final VoidCallback? onTap;

  /// Fire [AppHaptics.tap] before [onTap].
  final bool haptic;

  /// Draw the solid navy edge that collapses on press.
  final bool edge;

  /// Whether the surface reacts at all. A disabled surface never scales and
  /// shows its edge already collapsed (the layout never jumps).
  final bool enabled;

  /// Corner radius of the ripple and of the edge.
  final BorderRadius borderRadius;

  final bool _ownsTap;

  @override
  State<BbPressable> createState() => _BbPressableState();
}

class _BbPressableState extends State<BbPressable> {
  bool _pressed = false;

  void _setPressed(bool value) {
    if (_pressed == value || !mounted) return;
    setState(() => _pressed = value);
  }

  void _handleTap() {
    if (widget.haptic) AppHaptics.tap();
    widget.onTap?.call();
  }

  @override
  void didUpdateWidget(BbPressable oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.enabled) _pressed = false;
  }

  @override
  Widget build(BuildContext context) {
    final Duration duration = AppMotion.resolve(context, AppMotion.press);
    final bool pressed = widget.enabled && _pressed;

    Widget surface;
    if (widget._ownsTap) {
      surface = Material(
        type: MaterialType.transparency,
        child: InkWell(
          onTap: widget.enabled ? _handleTap : null,
          onHighlightChanged: _setPressed,
          borderRadius: widget.borderRadius,
          child: widget.child,
        ),
      );
    } else if (widget.enabled) {
      surface = Listener(
        onPointerDown: (_) => _setPressed(true),
        onPointerUp: (_) => _setPressed(false),
        onPointerCancel: (_) => _setPressed(false),
        child: widget.child,
      );
    } else {
      surface = widget.child;
    }

    if (widget.edge) {
      const double depth = BbPressable.edgeDepth;
      final bool collapsed = pressed || !widget.enabled;
      surface = Padding(
        padding: const EdgeInsets.only(bottom: depth),
        child: Stack(
          clipBehavior: Clip.none,
          children: <Widget>[
            Positioned.fill(
              child: Transform.translate(
                offset: const Offset(0, depth),
                child: DecoratedBox(
                  key: BbPressable.edgeKey,
                  decoration: BoxDecoration(
                    color: AppColors.blue,
                    borderRadius: widget.borderRadius,
                  ),
                ),
              ),
            ),
            TweenAnimationBuilder<double>(
              tween: Tween<double>(end: collapsed ? depth : 0),
              duration: duration,
              curve: AppMotion.easeOut,
              builder: (BuildContext context, double dy, Widget? child) =>
                  Transform.translate(offset: Offset(0, dy), child: child),
              child: surface,
            ),
          ],
        ),
      );
    }

    return AnimatedScale(
      scale: pressed ? AppMotion.pressScale : 1,
      duration: duration,
      curve: AppMotion.easeOut,
      child: surface,
    );
  }
}

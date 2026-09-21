import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// Caps a non-scrolling body at [maxWidth] and centres it, so a tablet or a
/// landscape phone shows the kit's proportions instead of one 600dp-wide card
/// stretched across 1000px of glass.
///
/// For a SCROLLING body use [KitInsets.list] on the scroll view's own padding
/// instead — that keeps the scrollbar at the screen edge, where a thumb
/// expects it, rather than pulling it inward with the content.
class KitContentColumn extends StatelessWidget {
  const KitContentColumn({
    super.key,
    this.maxWidth = OnboardingLayout.maxTabContentWidth,
    required this.child,
  });

  final double maxWidth;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    // `heightFactor: 1` — size to the CHILD's height, never to the incoming
    // maximum. A bare `Center` (RenderPositionedBox) expands to fill maxHeight
    // whenever it is finite, and `Scaffold.bottomNavigationBar` hands its bar
    // LOOSE BUT FINITE constraints: a docked bar wrapped in this column then
    // filled the entire screen, collapsed the Scaffold body to zero height and
    // published the screen height as `bottomBarInset` — which pushed the
    // floating Feedback pill clean off the bottom of the screen.
    return Center(
      heightFactor: 1,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: child,
      ),
    );
  }
}

/// Padding helpers for scrolling content.
class KitInsets {
  KitInsets._();

  /// Horizontal padding for a list or scroll view [width] wide: the [gutter] on
  /// a phone, growing to centre the content once the screen passes [max].
  ///
  /// Applied as the SCROLL VIEW's padding (not a wrapper around its children),
  /// so the scrollbar and the overscroll glow stay at the screen edge while the
  /// content column centres.
  static EdgeInsets list(
    double width, {
    double max = OnboardingLayout.maxTabContentWidth,
    double gutter = 14,
  }) {
    return EdgeInsets.symmetric(
      horizontal: math.max(gutter, (width - max) / 2),
    );
  }
}

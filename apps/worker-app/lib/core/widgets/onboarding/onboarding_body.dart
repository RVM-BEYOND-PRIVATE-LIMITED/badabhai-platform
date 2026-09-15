import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// The scrolling body every onboarding screen sits in — the piece that makes
/// the kit's fixed 390pt artboards run on EVERY device.
///
///  - It always SCROLLS, so a short screen (320×568, a landscape phone, the
///    keyboard up) can never throw a RenderFlex overflow; the content is just
///    reached by scrolling.
///  - Its content column stops at [OnboardingLayout.maxContentWidth] and
///    centres, so a tablet shows the kit's proportions instead of a CTA
///    stretched edge to edge.
///  - With [fillViewport] the column is at least as tall as the viewport, so a
///    layout built on `Spacer`s centres on a tall screen and still scrolls on a
///    short one (the same contract as `BbScrollSafeBody`).
class OnboardingBody extends StatelessWidget {
  const OnboardingBody({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
    this.fillViewport = false,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final bool fillViewport;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final EdgeInsets inset = padding.resolve(Directionality.of(context));
        final double width = math.max(
          0,
          math.min(
            OnboardingLayout.maxContentWidth,
            constraints.maxWidth - inset.horizontal,
          ),
        );
        Widget content = SizedBox(width: width, child: child);
        if (fillViewport && constraints.maxHeight.isFinite) {
          content = ConstrainedBox(
            constraints: BoxConstraints(
              minHeight: math.max(0, constraints.maxHeight - inset.vertical),
            ),
            child: IntrinsicHeight(child: content),
          );
        }
        return SingleChildScrollView(
          padding: inset,
          child: Center(child: content),
        );
      },
    );
  }
}

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';
import '../feedback_fab.dart';

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
///
/// [fillViewport] reaches that contract with an [IntrinsicHeight], which is the
/// only way to give a `Spacer` a finite height inside a scroll view. Intrinsics
/// cannot be measured through a [LayoutBuilder], so a [child] whose subtree
/// contains one must NOT use [fillViewport] — it throws "LayoutBuilder does not
/// support returning intrinsic dimensions". A body with no `Spacer` does not
/// need this widget at all: a [Column] inside a `minHeight` box already sizes
/// to `max(its content, the viewport)`, which is what the voice-note and
/// profile-preview screens do.
class OnboardingBody extends StatelessWidget {
  const OnboardingBody({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(20),
    this.fillViewport = false,
    this.maxWidth = OnboardingLayout.maxContentWidth,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final bool fillViewport;

  /// Where the content column stops and centres. 440 (a form) by default;
  /// tab-style content passes [OnboardingLayout.maxTabContentWidth].
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        // Reserve the band the app-wide floating Feedback pill occupies, so it
        // floats over empty canvas instead of over this page's last control.
        // 0 on every route where the pill is hidden, and in every isolated
        // widget test. See [FeedbackFabInset].
        final EdgeInsets inset = padding
            .resolve(Directionality.of(context))
            .add(EdgeInsets.only(bottom: FeedbackFabInset.of(context)))
            .resolve(Directionality.of(context));
        final double width = math.max(
          0,
          math.min(maxWidth, constraints.maxWidth - inset.horizontal),
        );
        Widget content = child;
        if (fillViewport && constraints.maxHeight.isFinite) {
          content = ConstrainedBox(
            constraints: BoxConstraints(
              minHeight: math.max(0, constraints.maxHeight - inset.vertical),
            ),
            child: IntrinsicHeight(child: content),
          );
        }
        // The width cap sits OUTSIDE the `IntrinsicHeight`, and that order is
        // load-bearing. `IntrinsicHeight` measures its child at the width of
        // the constraints IT is given, and a `SizedBox` inside it does not
        // change that width — so capping inside made a wrapping paragraph
        // measure at the full viewport width (one line on a 844x390 landscape
        // phone) and then lay out at 440 (two lines), which forced the column
        // into a height too small for it and overflowed instead of scrolling.
        content = SizedBox(width: width, child: content);
        return SingleChildScrollView(
          padding: inset,
          child: Center(child: content),
        );
      },
    );
  }
}

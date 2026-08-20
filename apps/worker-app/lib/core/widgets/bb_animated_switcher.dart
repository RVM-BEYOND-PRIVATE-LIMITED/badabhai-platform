import 'package:flutter/material.dart';

import '../theme/app_motion.dart';

/// A thin wrapper over [AnimatedSwitcher] wired to the BadaBhai motion tokens
/// (#1059): an [AppMotion.base] cross-fade on the [AppMotion.easeOut] curve.
///
/// Use it where a screen swaps between DISTINCT states — a status view
/// (loading → empty → ready → error) or an answer affordance (typing indicator →
/// chips) — so the change fades instead of flashing.
///
/// CONTRACT: each swapped child MUST carry a distinct [Key]. [AnimatedSwitcher]
/// treats children with equal keys (or both keyless) as the SAME child and skips
/// the animation — so give every state a `ValueKey` for the swap to play.
///
/// Layout: children are stacked top-aligned during a transition, so the switcher
/// is never taller than the taller of the two states (both of which already fit
/// on their own) — it cannot introduce a new overflow.
class BbAnimatedSwitcher extends StatelessWidget {
  const BbAnimatedSwitcher({
    super.key,
    required this.child,
    this.duration = AppMotion.base,
    this.alignment = Alignment.topCenter,
  });

  /// The current child. Change its [Key] to trigger the cross-fade.
  final Widget child;

  /// Fade duration — [AppMotion.base] by default.
  final Duration duration;

  /// How the outgoing and incoming children are aligned while both are on
  /// screen. Top-aligned by default so a bottom-anchored slot does not jiggle.
  final AlignmentGeometry alignment;

  @override
  Widget build(BuildContext context) {
    return AnimatedSwitcher(
      duration: duration,
      switchInCurve: AppMotion.easeOut,
      switchOutCurve: AppMotion.easeOut,
      layoutBuilder: (Widget? currentChild, List<Widget> previousChildren) {
        return Stack(
          alignment: alignment,
          children: <Widget>[
            ...previousChildren,
            if (currentChild != null) currentChild,
          ],
        );
      },
      child: child,
    );
  }
}

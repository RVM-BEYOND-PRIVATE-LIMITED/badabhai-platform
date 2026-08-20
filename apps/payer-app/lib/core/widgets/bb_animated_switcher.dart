import 'package:flutter/material.dart';

import '../theme/app_motion.dart';

/// A thin wrapper over [AnimatedSwitcher] wired to the design-system motion
/// tokens: a fade + size transition over [AppMotion.base] on [AppMotion.easeOut]
/// (#1078). Reach for it anywhere a `BlocBuilder`/state switch swaps one subtree
/// for a structurally different one — a loading→ready status card, a step swap —
/// so the change eases in instead of hard-cutting on a network round trip.
///
/// Give each swapped child a distinct [Key] (e.g. a `ValueKey` of the state);
/// without one, [AnimatedSwitcher] treats successive children as the same widget
/// and skips the transition.
///
/// The transition top-aligns the outgoing and incoming subtrees so a taller
/// child grows downward rather than wobbling around a shared centre — the right
/// default for forms and stacked cards. Children keep the parent's width
/// constraint, so full-width (`block`) content stays full-width mid-swap.
class BbAnimatedSwitcher extends StatelessWidget {
  const BbAnimatedSwitcher({
    super.key,
    required this.child,
    this.duration = AppMotion.base,
    this.alignment = Alignment.topCenter,
  });

  /// The current subtree. Change its [Key] to trigger the transition.
  final Widget child;

  /// Swap duration — defaults to the design system's [AppMotion.base] (220ms).
  final Duration duration;

  /// How overlapping (outgoing + incoming) children are aligned mid-swap.
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
      transitionBuilder: (Widget child, Animation<double> animation) {
        return FadeTransition(
          opacity: animation,
          child: SizeTransition(
            sizeFactor: animation,
            axisAlignment: -1,
            child: child,
          ),
        );
      },
      child: child,
    );
  }
}

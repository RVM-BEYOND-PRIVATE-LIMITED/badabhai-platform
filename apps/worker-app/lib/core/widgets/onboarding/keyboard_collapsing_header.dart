import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../theme/onboarding_theme.dart';

/// How long the header takes to fold away or come back. Matched to the
/// keyboard's own slide, so the two move as one.
const Duration kKeyboardHeaderCollapseDuration = Duration(milliseconds: 220);

/// A navy header that FOLDS AWAY while [collapsed] is true and comes back when
/// it turns false (owner ask `issue1.jpeg`: on a form page the soft keyboard
/// left almost no room for the page itself).
///
/// NO FLICKER, BY CONSTRUCTION:
///  * The SAME [child] stays mounted the whole time; only its visible height
///    animates (clip + height factor). Nothing is added to or removed from the
///    tree, so the page below — and the text field the worker is typing into —
///    never loses its state or its focus.
///  * One animation per change, eased; a rebuild mid-animation continues it
///    rather than restarting it.
///  * The STATUS BAR stays navy with light icons throughout: a band the height
///    of the status bar grows exactly as the header shrinks, so the clock and
///    battery never sit on a white page in white.
class KeyboardCollapsingHeader extends StatelessWidget {
  const KeyboardCollapsingHeader({
    super.key,
    required this.collapsed,
    required this.child,
  });

  /// True while the header should be folded away.
  final bool collapsed;

  /// The header itself — built once, kept mounted.
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final double statusBar = MediaQuery.paddingOf(context).top;
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.light,
      child: TweenAnimationBuilder<double>(
        tween: Tween<double>(end: collapsed ? 0 : 1),
        duration: kKeyboardHeaderCollapseDuration,
        curve: Curves.easeOutCubic,
        child: child,
        builder: (BuildContext context, double shown, Widget? header) {
          return ColoredBox(
            color: OnboardingColors.shiftBlue,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                // The status-bar band: zero while the header (which carries
                // its own status-bar padding) is fully shown, the full
                // status-bar height once it is folded away.
                SizedBox(height: statusBar * (1 - shown)),
                ClipRect(
                  child: Align(
                    alignment: Alignment.bottomCenter,
                    heightFactor: shown,
                    child: header,
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../router.dart';
import '../../theme/onboarding_theme.dart';
import '../../util/push_once.dart';

/// The yellow Feedback glyph in a tab header (spec §4).
///
/// **One glyph, one meaning.** The spec draws
/// `chat_bubble_outline_rounded` in safety yellow on the Resume header and
/// means FEEDBACK by it, so that is what it does here. The Bada Bhai tab is
/// where a worker goes to talk to the bot, so the header no longer carries a
/// second chat entry point.
///
/// It carries the route the worker was ON as `extra`, exactly like the floating
/// pill — that is the whole answer to "which button kaam nahi kar raha". The
/// value travels in memory, never in the URL, and is normalized to a route
/// PATTERN at the wire boundary, so no identifier leaves the device.
class KitFeedbackAction extends StatelessWidget {
  const KitFeedbackAction({super.key});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: 'Feedback',
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints.tightFor(
        width: OnboardingLayout.tapTarget,
        height: OnboardingLayout.tapTarget,
      ),
      icon: const Icon(
        Icons.chat_bubble_outline_rounded,
        size: 20,
        color: OnboardingColors.safetyYellow,
      ),
      onPressed: () => context.pushOnce(
        Routes.feedback,
        extra: GoRouterState.of(context).uri.path,
      ),
    );
  }
}

/// The Feedback action as a WORD rather than the yellow glyph.
///
/// Same destination, same `extra` (the route the worker was on) and the same
/// anti-stack push as [KitFeedbackAction] — only the drawing differs. A screen
/// picks ONE of the two: a screen that shows this must not also float the
/// global Feedback pill, or the worker is offered the same action twice.
///
/// Drawn in the header's muted slate rather than safety yellow: it sits beside
/// the title, and a yellow word there competes with the title for the eye,
/// which the glyph (a small mark in the corner) does not.
class KitFeedbackTextAction extends StatelessWidget {
  const KitFeedbackTextAction({super.key, this.label = 'Feedback'});

  /// Rendered UPPERCASE; the source string stays readable.
  final String label;

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: () => context.pushOnce(
        Routes.feedback,
        extra: GoRouterState.of(context).uri.path,
      ),
      style: TextButton.styleFrom(
        // The 48dp touch floor, kept without padding the word away from the
        // header's right gutter.
        minimumSize: const Size(0, OnboardingLayout.tapTarget),
        padding: const EdgeInsets.symmetric(horizontal: 8),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        foregroundColor: OnboardingColors.textOnBlueMuted,
      ),
      child: Text(
        label.toUpperCase(),
        style: OnboardingTypography.inter(
          size: 12,
          weight: FontWeight.w700,
          letterSpacing: 1,
          color: OnboardingColors.textOnBlueMuted,
        ),
      ),
    );
  }
}

/// Any other header glyph — the bell, search, download, settings.
///
/// The glyph is painted at [size] (the spec's 22) inside a 48x48 hit box, so a
/// small icon still clears the worker touch floor without being drawn bigger.
class KitHeaderIconAction extends StatelessWidget {
  const KitHeaderIconAction({
    super.key,
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    this.color = OnboardingColors.textOnBlue,
    this.size = 22,
  });

  final IconData icon;

  /// Also the accessible name — every header glyph is unlabelled otherwise.
  final String tooltip;
  final VoidCallback? onPressed;
  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: tooltip,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints.tightFor(
        width: OnboardingLayout.tapTarget,
        height: OnboardingLayout.tapTarget,
      ),
      icon: Icon(icon, size: size, color: color),
      onPressed: onPressed,
    );
  }
}

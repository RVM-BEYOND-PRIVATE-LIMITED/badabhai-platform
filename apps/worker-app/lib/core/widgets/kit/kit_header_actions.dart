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

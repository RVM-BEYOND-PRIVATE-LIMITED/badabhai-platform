import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';

/// The profile card's two actions — share and download — side by side
/// (spec §4), and ONE ABOVE THE OTHER when that would not fit.
///
/// It owns layout only. The buttons themselves are passed in, so the share
/// button keeps its own #354 bytes-not-url logic and the download button its
/// #398 name prefetch and render poll: this widget cannot change what they do.
///
/// ── WHY IT STACKS ───────────────────────────────────────────────────────────
///
/// The two labels are 'WhatsApp pe bhejein' and 'PDF download karein', and the
/// download button swaps to the longer 'PDF taiyaar ho rahi hai…' while the
/// server renders. Two of those side by side inside a 16dp-padded card on a
/// 320dp handset leaves each about 130dp — the labels ellipsise to
/// 'WhatsApp…' / 'PDF tai…', which is not a button a worker can read. Below
/// [_kStackBelowWidth] of available width, or past a 1.3 text scale, they go
/// vertical and each gets the full width.
class ResumeActionRow extends StatelessWidget {
  const ResumeActionRow({
    super.key,
    required this.share,
    required this.download,
  });

  /// The green share action (money / WhatsApp tone).
  final Widget share;

  /// The navy download action.
  final Widget download;

  /// Measured, not guessed: the narrowest width at which both labels still
  /// render in full at a 1.0 text scale.
  static const double _kStackBelowWidth = 340;

  static const double _kGap = 10;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final bool largeText =
            MediaQuery.textScalerOf(context).scale(14) >
            14 * OnboardingLayout.chromeMaxTextScale;
        final bool stack =
            constraints.maxWidth < _kStackBelowWidth || largeText;
        if (stack) {
          return Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              share,
              const SizedBox(height: _kGap),
              download,
            ],
          );
        }
        return Row(
          children: <Widget>[
            Expanded(child: share),
            const SizedBox(width: _kGap),
            Expanded(child: download),
          ],
        );
      },
    );
  }
}

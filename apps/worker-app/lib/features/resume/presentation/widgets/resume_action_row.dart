import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';

/// The profile card's two actions — share and download — always side by
/// side (spec §4).
///
/// It owns layout only. The buttons themselves are passed in, so the share
/// button keeps its own #354 bytes-not-url logic and the download button its
/// #398 name prefetch and render poll: this widget cannot change what they do.
///
/// ── ALWAYS HORIZONTAL ───────────────────────────────────────────────────────
///
/// The two labels are the short 'Share' and 'Download', so the pair fits one
/// row on every handset (even 320dp) with room to spare — no stacked layout,
/// no width threshold. At a large system font the labels wrap to two lines
/// (both buttons opt into `allowMultilineLabel`) and the buttons grow
/// taller instead of clipping, so there is still no overflow to guard.
class ResumeActionRow extends StatelessWidget {
  const ResumeActionRow({
    super.key,
    required this.share,
    required this.download,
    this.note,
  });

  /// The green share action (money / WhatsApp tone).
  final Widget share;

  /// The navy download action.
  final Widget download;

  /// One line under the pair saying why it is disabled — a PDF whose render
  /// failed. Null draws nothing.
  final String? note;

  static const double _kGap = 10;

  @override
  Widget build(BuildContext context) {
    final Widget row = Row(
      children: <Widget>[
        Expanded(child: share),
        const SizedBox(width: _kGap),
        Expanded(child: download),
      ],
    );
    final String? reason = note;
    if (reason == null) return row;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        row,
        const SizedBox(height: 8),
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            const Icon(
              Icons.error_rounded,
              size: 16,
              color: OnboardingColors.errorRed,
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Text(
                reason,
                style: OnboardingTypography.inter(
                  size: 12,
                  weight: FontWeight.w600,
                  height: 1.4,
                  color: OnboardingColors.errorRed,
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}

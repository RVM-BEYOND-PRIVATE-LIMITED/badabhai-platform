import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// The informational callout (spec §4): a pale blue panel with an optional
/// navy glyph tile, a micro title and a line of supporting text.
///
/// Used for a fact that needs framing rather than listing — the spec's
/// drawing-reading / GD&T panel.
class KitCallout extends StatelessWidget {
  const KitCallout({
    super.key,
    this.title,
    this.text,
    this.tileIcon,
    this.child,
  });

  final String? title;
  final String? text;

  /// Draws the 36x36 navy tile with this glyph in safety yellow. Omitted → no
  /// tile, and the text runs the full width.
  final IconData? tileIcon;

  /// Replaces [title]/[text] entirely for a caller that needs richer content.
  final Widget? child;

  @override
  Widget build(BuildContext context) {
    final String? titleText = title;
    final String? bodyText = text;
    final IconData? icon = tileIcon;

    final Widget content =
        child ??
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (titleText != null && titleText.isNotEmpty)
              Text(
                titleText.toUpperCase(),
                style: OnboardingTypography.inter(
                  size: 10,
                  weight: FontWeight.w800,
                  color: OnboardingColors.infoTitle,
                ),
              ),
            if (titleText != null &&
                titleText.isNotEmpty &&
                bodyText != null &&
                bodyText.isNotEmpty)
              const SizedBox(height: 2),
            if (bodyText != null && bodyText.isNotEmpty)
              Text(
                bodyText,
                style: OnboardingTypography.inter(
                  size: 12,
                  weight: FontWeight.w600,
                  height: 1.4,
                  color: OnboardingColors.infoText,
                ),
              ),
          ],
        );

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: OnboardingColors.infoBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.note),
        border: Border.all(color: OnboardingColors.infoBorder),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Container(
              width: 36,
              height: 36,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: OnboardingColors.shiftBlue,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Icon(icon, size: 20, color: OnboardingColors.safetyYellow),
            ),
            const SizedBox(width: 12),
          ],
          Expanded(child: content),
        ],
      ),
    );
  }
}

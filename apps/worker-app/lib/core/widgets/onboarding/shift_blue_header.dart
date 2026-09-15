import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';
import 'brand_badge.dart';

/// The persistent Shift Blue header (master spec §2.1): a full-bleed navy band
/// carrying the status-bar inset; a top row with the back arrow and the
/// BADABHAI badge; an optional uppercase STEP badge; then the white Anek title
/// and an optional muted Inter subtitle.
///
/// Kept beyond the spec's sketch: text scaling clamps at
/// [OnboardingLayout.chromeMaxTextScale] (an unclamped two-line subtitle at 200%
/// font ate most of a small phone), and the inner column caps at
/// [OnboardingLayout.maxContentWidth] and centres on tablets / landscape.
///
/// [OnboardingVariant.formFlow] draws the form-flow mockups' header: a 20dp
/// gutter with the back arrow's glyph on that gutter (its tap area stays 48dp),
/// a lower top row, a more spaced slate STEP line, a deeper bottom and the
/// form-flow [BrandBadge]. Every other screen keeps the standard drawing.
class ShiftBlueHeader extends StatelessWidget {
  const ShiftBlueHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.stepBadge,
    this.onBack,
    this.showBrandBadge = true,
    this.trailing,
    this.titleColor = OnboardingColors.textOnBlue,
    this.variant = OnboardingVariant.standard,
  });

  final String title;
  final String? subtitle;

  /// e.g. "Step 2 of 6" — rendered uppercase above the title.
  final String? stepBadge;

  /// Draws the back arrow when non-null (a 48px IconButton, per the spec).
  final VoidCallback? onBack;
  final bool showBrandBadge;

  /// Replaces the brand badge on the right of the top row when non-null (e.g.
  /// a Feedback link on a screen that owns one).
  final Widget? trailing;

  /// The title colour. White by default; the form flow's question screens use
  /// safety yellow (the Workholding / Measuring / Operations mockups).
  final Color titleColor;

  final OnboardingVariant variant;

  @override
  Widget build(BuildContext context) {
    final double top = MediaQuery.paddingOf(context).top;
    final bool form = variant == OnboardingVariant.formFlow;
    final double side = form ? FormFlowLayout.gutter : 16;
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        width: double.infinity,
        color: OnboardingColors.shiftBlue,
        padding: EdgeInsets.only(
          top: top + (form ? FormFlowLayout.headerTopPadding : 8),
          bottom: form ? FormFlowLayout.headerBottomPadding : 20,
          left: side,
          right: side,
        ),
        child: Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              maxWidth: OnboardingLayout.maxContentWidth,
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                SizedBox(
                  height: OnboardingLayout.tapTarget,
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: <Widget>[
                      if (onBack != null)
                        _BackButton(onBack: onBack!, alignToGutter: form)
                      else
                        const SizedBox(width: 24),
                      if (trailing != null)
                        trailing!
                      else if (showBrandBadge)
                        BrandBadge(variant: variant),
                    ],
                  ),
                ),
                if (stepBadge != null) ...<Widget>[
                  SizedBox(height: form ? FormFlowLayout.headerRowToStepGap : 8),
                  Text(
                    stepBadge!.toUpperCase(),
                    style: form
                        ? OnboardingTypography.formStepLine()
                        : OnboardingTypography.inter(
                            size: 10,
                            weight: FontWeight.w700,
                            letterSpacing: 1,
                            color: OnboardingColors.textOnBlueMuted,
                          ),
                  ),
                ],
                const SizedBox(height: 8),
                Text(
                  title,
                  style: OnboardingTypography.headerTitle(color: titleColor),
                ),
                if (subtitle != null && subtitle!.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 6),
                  Text(
                    subtitle!,
                    style: OnboardingTypography.inter(
                      size: 13,
                      color: OnboardingColors.textOnBlueMuted,
                      height: 1.35,
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The header's back arrow: a 24dp glyph in a 48dp tap target. With
/// [alignToGutter] the glyph sits on the header's left gutter (the form-flow
/// mockups) instead of centred in its target.
class _BackButton extends StatelessWidget {
  const _BackButton({required this.onBack, required this.alignToGutter});

  final VoidCallback onBack;
  final bool alignToGutter;

  static const Icon _arrow = Icon(
    Icons.arrow_back_rounded,
    color: OnboardingColors.textOnBlue,
    size: 24,
  );

  @override
  Widget build(BuildContext context) {
    if (!alignToGutter) {
      return IconButton(tooltip: 'Wapas', onPressed: onBack, icon: _arrow);
    }
    return IconButton(
      tooltip: 'Wapas',
      onPressed: onBack,
      padding: EdgeInsets.zero,
      alignment: Alignment.centerLeft,
      constraints: const BoxConstraints.tightFor(
        width: OnboardingLayout.tapTarget,
        height: OnboardingLayout.tapTarget,
      ),
      icon: _arrow,
    );
  }
}

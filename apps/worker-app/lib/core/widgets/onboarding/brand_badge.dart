import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// The "BADABHAI" monogram pill in the Shift Blue header (master spec §2.1):
/// a two-figure glyph in safety yellow beside the uppercase wordmark, on a 12%
/// white wash with a 25% white hairline.
///
/// [OnboardingVariant.formFlow] draws the form-flow mockups' pill: a two-tone
/// glyph (a small white figure beside a larger yellow one), a barely-visible
/// hairline, wider side padding and a more tracked wordmark. Same height.
class BrandBadge extends StatelessWidget {
  const BrandBadge({super.key, this.variant = OnboardingVariant.standard});

  final OnboardingVariant variant;

  @override
  Widget build(BuildContext context) {
    final bool form = variant == OnboardingVariant.formFlow;
    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: form ? FormFlowLayout.brandBadgePaddingH : 10,
        vertical: 5,
      ),
      decoration: BoxDecoration(
        color: Colors.white.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(OnboardingRadii.badge),
        border: Border.all(
          color: form
              ? FormFlowColors.brandBadgeBorder
              : Colors.white.withValues(alpha: 0.25),
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (form)
            const _TwoToneFigures()
          else
            const Icon(
              Icons.people_alt_rounded,
              size: 14,
              color: OnboardingColors.safetyYellow,
            ),
          SizedBox(width: form ? FormFlowLayout.brandBadgeIconGap : 6),
          Text(
            'BADABHAI',
            style: OnboardingTypography.anek(
              size: form ? FormFlowLayout.brandBadgeWordmarkSize : 11,
              weight: FontWeight.w800,
              color: OnboardingColors.textOnBlue,
              letterSpacing:
                  form ? FormFlowLayout.brandBadgeLetterSpacing : 0.5,
            ),
          ),
        ],
      ),
    );
  }
}

/// The form-flow pill's glyph: a small white figure and a larger yellow one,
/// bottom-aligned, ~16x10dp of ink in the same 14dp-tall box as the standard
/// icon (so the pill's height does not change).
class _TwoToneFigures extends StatelessWidget {
  const _TwoToneFigures();

  static const double _width = 16;
  static const double _height = 14;
  static const double _small = 9;
  static const double _large = 14;

  /// A Material person glyph's ink fills 2/3 of its box, centred.
  static double _inset(double size) => size / 6;

  @override
  Widget build(BuildContext context) {
    final double largeInkBottom = _large - _inset(_large);
    return SizedBox(
      width: _width,
      height: _height,
      child: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          Positioned(
            left: -_inset(_small),
            top: largeInkBottom + _inset(_small) - _small,
            child: const Icon(
              Icons.person_rounded,
              size: _small,
              color: OnboardingColors.textOnBlue,
            ),
          ),
          Positioned(
            right: -_inset(_large),
            top: 0,
            child: const Icon(
              Icons.person_rounded,
              size: _large,
              color: OnboardingColors.safetyYellow,
            ),
          ),
        ],
      ),
    );
  }
}

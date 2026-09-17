import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// The BadaBhai brand lockup in the Shift Blue header: the two-figure mark
/// beside the **BadaBhai** wordmark, drawn directly on the navy band.
///
/// NO PILL. The lockup used to sit in a 12%-white wash with a 25%-white
/// hairline and an uppercase wordmark; the owner removed the border and
/// background permanently and moved the wordmark to mixed case ("BadaBhai").
/// There is deliberately no decoration here to restore.
///
/// THE MARK IS AN IMAGE, not a drawn glyph: the owner's
/// `assets/fonts/image/badabhai_main.png` (a small white man beside a large
/// yellow man, transparent background) is shown to the LEFT of the wordmark.
/// It is the single source for every screen that shows this lockup.
class BrandBadge extends StatelessWidget {
  const BrandBadge({super.key});

  /// The brand mark asset — also pinned by `brand_badge_test.dart`.
  static const String markAsset = 'assets/fonts/image/badabhai_main.png';

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Image.asset(
          markAsset,
          width: 16,
          height: 16,
          // Downscaled from 1080px, so ask for a smooth resample rather than
          // the default nearest.
          filterQuality: FilterQuality.high,
          // Decorative: the wordmark beside it already names the brand.
          excludeFromSemantics: true,
        ),
        const SizedBox(width: 6),
        Text(
          // Brand name is always one word, two capitals.
          'BadaBhai',
          style: OnboardingTypography.anek(
            size: 12,
            weight: FontWeight.w800,
            color: OnboardingColors.textOnBlue,
          ),
        ),
      ],
    );
  }
}

import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';
import '../theme/onboarding_theme.dart';

/// Inline "Verified" pill — a green check on the success tint.
///
/// The trust marker shown next to a CONFIRMED fact. It means someone checked;
/// never put it beside a self-declared value.
///
/// It CLAMPS ITS OWN TEXT SCALING at [OnboardingLayout.chromeMaxTextScale],
/// like the rest of the chrome. A pill is a status marker, not body copy, and
/// its icon and label sit in a `Row` with no flexible child — at a 2.0 system
/// font that Row asked for 211dp inside the 168dp identity column on a 320dp
/// phone and overflowed. The label cannot be made `Flexible` instead: callers
/// legitimately place the pill under a `FittedBox`, where the incoming width is
/// unbounded and a flex child would assert.
class BbVerifiedBadge extends StatelessWidget {
  const BbVerifiedBadge({super.key, this.label = 'Verified'});

  final String label;

  @override
  Widget build(BuildContext context) {
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
        decoration: const BoxDecoration(
          color: OnboardingColors.successBg,
          borderRadius: BorderRadius.all(Radius.circular(AppRadii.pill)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            const Icon(
              Icons.verified,
              size: 14,
              color: OnboardingColors.successGreen,
            ),
            const SizedBox(width: 5),
            Text(
              label,
              style: OnboardingTypography.inter(
                size: 12,
                weight: FontWeight.w700,
                color: OnboardingColors.successGreen,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Circular verified seal for avatar / photo overlays: a green check on a white
/// disc, so it reads as a badge when stamped onto a worker's photo.
class BbSeal extends StatelessWidget {
  const BbSeal({super.key, this.size = 20});

  /// Diameter of the verified glyph; the disc is sized to frame it.
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: const BoxDecoration(
        color: OnboardingColors.paperWhite,
        shape: BoxShape.circle,
      ),
      child: Icon(
        Icons.verified,
        size: size,
        color: OnboardingColors.successGreen,
      ),
    );
  }
}

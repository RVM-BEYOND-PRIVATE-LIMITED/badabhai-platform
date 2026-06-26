import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// Inline "Verified" pill — green check on a soft green tint.
///
/// Ports `.aw-badge-verified` (ui.css 201): the trust marker shown next to a
/// confirmed skill, KYC step, or profile field. Green is the BadaBhai "go" /
/// verified colour.
class BbVerifiedBadge extends StatelessWidget {
  const BbVerifiedBadge({super.key, this.label = 'Verified'});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
      decoration: const BoxDecoration(
        color: AppColors.successTint,
        borderRadius: BorderRadius.all(Radius.circular(AppRadii.pill)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          const Icon(Icons.verified, size: 16, color: AppColors.success),
          const SizedBox(width: 5),
          Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: AppColors.success,
            ),
          ),
        ],
      ),
    );
  }
}

/// Circular verified seal for avatar / photo overlays.
///
/// Ports `.aw-prof__seal` (ui.css 197): a green check sitting on a white card
/// disc so it reads as a badge when stamped onto a worker's photo.
class BbSeal extends StatelessWidget {
  const BbSeal({super.key, this.size = 20});

  /// Diameter of the verified glyph; the disc is sized to frame it.
  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(2),
      decoration: const BoxDecoration(
        color: AppColors.surfaceCard,
        shape: BoxShape.circle,
      ),
      child: Icon(Icons.verified, size: size, color: AppColors.success),
    );
  }
}

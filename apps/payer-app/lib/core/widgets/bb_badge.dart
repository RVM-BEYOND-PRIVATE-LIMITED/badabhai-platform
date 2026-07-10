import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// Semantic tone of a [BbBadge] — the design system's `.bb-badge--*` set.
///
///  - [success] — green: verified, "Active", money/fit-positive states.
///  - [neutral] — quiet sunken pill: skills, "Quota reached", default chips.
///  - [warning] — saffron: "In review", attention-but-fine.
///  - [danger]  — crimson: the "Hot" flag on a minority of candidates.
///  - [brand]   — vermilion: "Boosted", "Best value".
///  - [info]    — turquoise: "In window" attribution state.
enum BbBadgeTone { success, neutral, warning, danger, brand, info }

/// A small status pill — `.bb-badge`. Static label (+ optional leading icon);
/// never a tap target. [solid] flips to a filled, inverse-text variant used for
/// the "Hot" and "Best value" flags.
///
/// Soft, never numeric: fit is shown as "Strong fit" / "Good fit", never a score.
class BbBadge extends StatelessWidget {
  const BbBadge(
    this.label, {
    super.key,
    this.tone = BbBadgeTone.neutral,
    this.icon,
    this.solid = false,
  });

  final String label;
  final BbBadgeTone tone;
  final IconData? icon;
  final bool solid;

  @override
  Widget build(BuildContext context) {
    final (Color tint, Color fg, Color solidBg) = switch (tone) {
      BbBadgeTone.success => (
          AppColors.successTint,
          AppColors.green700,
          AppColors.success,
        ),
      BbBadgeTone.neutral => (
          AppColors.surfaceSunken,
          AppColors.textSecondary,
          AppColors.ink700,
        ),
      BbBadgeTone.warning => (
          AppColors.warningTint,
          AppColors.saffron700,
          AppColors.saffronDeep,
        ),
      BbBadgeTone.danger => (
          AppColors.dangerTint,
          AppColors.red700,
          AppColors.danger,
        ),
      BbBadgeTone.brand => (
          AppColors.brandTint,
          AppColors.brandPress,
          AppColors.brand,
        ),
      BbBadgeTone.info => (
          AppColors.infoTint,
          AppColors.teal700,
          AppColors.teal500,
        ),
    };

    final Color background = solid ? solidBg : tint;
    final Color foreground = solid ? AppColors.textOnBrand : fg;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s2, vertical: 4),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppRadii.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 13, color: foreground),
            const SizedBox(width: 4),
          ],
          Text(
            label,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              weight: FontWeight.w700,
              color: foreground,
            ),
          ),
        ],
      ),
    );
  }
}

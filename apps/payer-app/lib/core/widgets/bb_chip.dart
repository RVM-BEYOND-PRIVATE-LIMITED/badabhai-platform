import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// A pill-shaped selectable chip — the design system's `.aw-chip` (ui.css
/// 46–47). Used for skills/tags and single-select filters in the worker app.
///
/// Default sits quiet on a card (warm hairline border); [selected] flips to the
/// vermilion brand tint. Optional leading [icon] follows the text colour.
class BbChip extends StatelessWidget {
  const BbChip({
    super.key,
    required this.label,
    this.selected = false,
    this.onTap,
    this.icon,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final Color background =
        selected ? AppColors.vermilion50 : AppColors.surfaceCard;
    final Color borderColor =
        selected ? AppColors.brand : AppColors.borderStrong;
    final Color foreground =
        selected ? AppColors.brandPress : AppColors.textPrimary;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AppRadii.pill),
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: AppSpacing.tap),
          child: Container(
            alignment: Alignment.center,
            padding: const EdgeInsets.symmetric(
              horizontal: 15,
              vertical: AppSpacing.s2,
            ),
            decoration: BoxDecoration(
              color: background,
              borderRadius: BorderRadius.circular(AppRadii.pill),
              border: Border.all(color: borderColor, width: 1.5),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (icon != null) ...<Widget>[
                  Icon(icon, size: 18, color: foreground),
                  const SizedBox(width: 6),
                ],
                Text(
                  label,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    weight: FontWeight.w700,
                    color: foreground,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

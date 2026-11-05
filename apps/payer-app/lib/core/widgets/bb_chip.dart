import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_pressable.dart';

/// A pill-shaped selectable chip — the design system's `.aw-chip` (ui.css
/// 46–47). Used for skills/tags and single-select filters in the worker app.
///
/// Default sits quiet on a card (paper + hairline border); [selected] flips to a
/// SOLID haldi fill with a deep-blue normal-face label — the kit's `BBFilterChip`. A
/// soft 14px pill (JUL31 `rChip`). Optional leading [icon] follows the text colour.
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
    // JUL31 kit: a selected filter chip is a SOLID haldi pill (not a tint) with
    // a deep-blue label; unselected sits on paper behind a hairline.
    final Color background =
        selected ? AppColors.brand : AppColors.surfaceCard;
    final Color borderColor =
        selected ? AppColors.brand : AppColors.borderStrong;
    final Color foreground =
        selected ? AppColors.onHaldi : AppColors.textPrimary;

    // Selected and unselected chips both speak in the normal UI face (Inter).
    final TextStyle labelStyle = selected
        ? AppTypography.heading(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
            color: foreground,
          )
        : AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
            color: foreground,
          );

    final BorderRadius radius = BorderRadius.circular(AppRadii.chip);
    final BoxDecoration pill = BoxDecoration(
      color: background,
      borderRadius: radius,
      border: Border.all(color: borderColor, width: 1.5),
    );
    final Widget content = Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        if (icon != null) ...<Widget>[
          Icon(icon, size: 18, color: foreground),
          const SizedBox(width: 6),
        ],
        Flexible(
          child: Text(
            label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: labelStyle,
          ),
        ),
      ],
    );
    const EdgeInsets pad = EdgeInsets.symmetric(
      horizontal: 15,
      vertical: AppSpacing.s2,
    );

    // #2591 — the pill is painted with [Ink] (not a Container decoration) so
    // the tap ripple shows ON the chip instead of under its fill.
    return BbPressable(
      onTap: onTap,
      borderRadius: radius,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: AppSpacing.tap),
        child: Ink(
          decoration: pill,
          child: Container(
            alignment: Alignment.center,
            padding: pad,
            child: content,
          ),
        ),
      ),
    );
  }
}

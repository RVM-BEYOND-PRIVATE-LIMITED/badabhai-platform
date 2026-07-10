import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// Trend direction of a [BbStat] delta — `.bb-stat__delta--*`.
enum BbStatDelta { up, down, flat }

/// A compact metric tile — `.bb-stat`. Label + Phosphor-paired icon on top, a
/// large Roboto-Mono value, and a small coloured delta line. Used in the Home
/// 2x2 grid (repeat-unlock rate, credit balance, active jobs, candidates).
///
/// The value is always mono (it's a number); the delta colour follows the
/// trend. An optional [onDeltaTap] turns the delta into an action link
/// (e.g. "Buy credits").
class BbStat extends StatelessWidget {
  const BbStat({
    super.key,
    required this.label,
    required this.value,
    required this.icon,
    required this.deltaText,
    this.delta = BbStatDelta.flat,
    this.onDeltaTap,
  });

  final String label;
  final String value;
  final IconData icon;
  final String deltaText;
  final BbStatDelta delta;
  final VoidCallback? onDeltaTap;

  @override
  Widget build(BuildContext context) {
    final (Color deltaColor, IconData deltaIcon) = switch (delta) {
      BbStatDelta.up => (AppColors.success, Icons.trending_up),
      BbStatDelta.down => (AppColors.danger, Icons.trending_down),
      BbStatDelta.flat => (AppColors.textMuted, Icons.remove),
    };

    final Widget deltaRow = Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(deltaIcon, size: 14, color: deltaColor),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            deltaText,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              weight: FontWeight.w600,
              color: deltaColor,
            ),
          ),
        ),
      ],
    );

    return Container(
      padding: const EdgeInsets.all(AppSpacing.s4),
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.borderSubtle),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: AppColors.ink900.withValues(alpha: 0.06),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: Text(
                  label,
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    weight: FontWeight.w600,
                    color: AppColors.textMuted,
                  ),
                ),
              ),
              Icon(icon, size: 16, color: AppColors.textFaint),
            ],
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            value,
            style: AppTypography.mono(
              size: AppTypography.size2xl,
              weight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: AppSpacing.s1),
          if (onDeltaTap != null)
            InkWell(
              onTap: onDeltaTap,
              borderRadius: BorderRadius.circular(AppRadii.xs),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 2),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: <Widget>[
                    const Icon(Icons.add, size: 14, color: AppColors.success),
                    const SizedBox(width: 4),
                    Text(
                      deltaText,
                      style: AppTypography.body(
                        size: AppTypography.sizeXs,
                        weight: FontWeight.w700,
                        color: AppColors.success,
                      ),
                    ),
                  ],
                ),
              ),
            )
          else
            deltaRow,
        ],
      ),
    );
  }
}

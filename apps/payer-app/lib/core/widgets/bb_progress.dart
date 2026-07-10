import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// A labelled progress meter — the design system's `.bb-progress`. A head row
/// (label + a Roboto-Mono "filled/quota" count) over a slim sunken track with a
/// green ("go") fill that animates to [value] on build.
///
/// Used for a job's applicant-quota. [success] tone is identical here (the fill
/// is always green); the flag is kept for parity with the kit's modifier.
class BbProgress extends StatelessWidget {
  const BbProgress({
    super.key,
    required this.value,
    this.label,
    this.countText,
  });

  /// Completion fraction, `0..1` (clamped).
  final double value;
  final String? label;

  /// Mono count shown on the right of the head row (e.g. "7/10").
  final String? countText;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        if (label != null || countText != null) ...<Widget>[
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: <Widget>[
              if (label != null)
                Text(
                  label!,
                  style: AppTypography.body(
                    size: AppTypography.sizeXs,
                    weight: FontWeight.w600,
                    color: AppColors.textSecondary,
                  ),
                ),
              if (countText != null)
                Text(
                  countText!,
                  style: AppTypography.mono(
                    size: AppTypography.sizeXs,
                    weight: FontWeight.w700,
                    color: AppColors.textPrimary,
                  ),
                ),
            ],
          ),
          const SizedBox(height: AppSpacing.s2),
        ],
        ClipRRect(
          borderRadius: BorderRadius.circular(AppRadii.pill),
          child: Container(
            height: 10,
            color: AppColors.surfaceInset,
            child: TweenAnimationBuilder<double>(
              tween: Tween<double>(begin: 0, end: value.clamp(0, 1)),
              duration: AppMotion.slow,
              curve: AppMotion.easeOut,
              builder: (BuildContext context, double t, _) {
                return FractionallySizedBox(
                  widthFactor: t,
                  alignment: Alignment.centerLeft,
                  child: const DecoratedBox(
                    decoration: BoxDecoration(color: AppColors.success),
                  ),
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}

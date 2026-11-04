import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// How far through a multi-section form the payer is (#2595, M7) — "2 of 4
/// sections done" over a slim bar that fills to the new step over
/// [AppMotion.progress] (ease-out) as a section is completed, and back when one
/// is undone.
///
/// The fill is a haldi (active-state) bar scaled from its leading edge —
/// transform only, nothing loops, and it jumps straight to the value under
/// reduced motion. The first build shows the value as-is (no fill-in on open).
class BbStepProgress extends StatelessWidget {
  const BbStepProgress({
    super.key,
    required this.done,
    required this.total,
    this.unit = 'sections',
  });

  /// Steps completed, `0..total`.
  final int done;
  final int total;

  /// What a step is called in the caption ("2 of 4 [unit] done").
  final String unit;

  /// Height of the bar.
  static const double barHeight = AppSpacing.s1;

  /// Key of the scaled fill (for widget tests).
  @visibleForTesting
  static const Key fillKey = Key('bb_step_progress_fill');

  double get _value => total <= 0 ? 0 : (done / total).clamp(0.0, 1.0);

  @override
  Widget build(BuildContext context) {
    final String caption = '$done of $total $unit done';
    return Semantics(
      label: 'Form progress',
      value: caption,
      child: ExcludeSemantics(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            Text(
              caption,
              style: AppTypography.body(
                size: AppTypography.sizeXs,
                weight: FontWeight.w600,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: AppSpacing.s1),
            ClipRRect(
              borderRadius: BorderRadius.circular(AppRadii.pill),
              child: SizedBox(
                height: barHeight,
                child: ColoredBox(
                  color: AppColors.surfaceInset,
                  child: TweenAnimationBuilder<double>(
                    tween: Tween<double>(end: _value),
                    duration: AppMotion.resolve(context, AppMotion.progress),
                    curve: AppMotion.easeOut,
                    builder: (BuildContext context, double t, Widget? child) =>
                        Transform.scale(
                      key: fillKey,
                      scaleX: t,
                      alignment: Alignment.centerLeft,
                      child: child,
                    ),
                    child: const ColoredBox(
                      color: AppColors.brand,
                      child: SizedBox.expand(),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

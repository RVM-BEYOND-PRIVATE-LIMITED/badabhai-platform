import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';

/// A slim, pill-shaped progress meter — the design system's `.aw-prog`.
///
/// Sunken cream track with a green ("go") fill that animates up to [value] on
/// first build, like a stamp creeping across paper. Used for the profiling
/// journey's step meter and the resume-readiness bar.
class BbProgressBar extends StatelessWidget {
  const BbProgressBar({super.key, required this.value});

  /// Completion fraction, `0..1`. Values outside the range are clamped.
  final double value;

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(AppRadii.pill),
      child: Container(
        height: 12,
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
    );
  }
}

import 'package:flutter/material.dart';

import '../theme/app_motion.dart';
import '../theme/app_spacing.dart';
import '../theme/onboarding_theme.dart';

/// A slim, pill-shaped progress meter.
///
/// A hairline track with a safety-yellow fill that animates up to [value] on
/// first build. Used for the profiling journey's step meter and the
/// resume-readiness bar — yellow, because progress is the thing the worker is
/// meant to look at, and green is reserved for money and success.
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
        color: OnboardingColors.borderSubtle,
        child: TweenAnimationBuilder<double>(
          tween: Tween<double>(begin: 0, end: value.clamp(0, 1)),
          duration: AppMotion.slow,
          curve: AppMotion.easeOut,
          builder: (BuildContext context, double t, _) {
            return FractionallySizedBox(
              widthFactor: t,
              alignment: Alignment.centerLeft,
              child: const DecoratedBox(
                decoration: BoxDecoration(color: OnboardingColors.safetyYellow),
              ),
            );
          },
        ),
      ),
    );
  }
}

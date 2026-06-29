import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';

/// The masked PIN indicator: a row of dots that FILL as digits are entered.
///
/// SECURITY: it renders only the COUNT of entered digits, never the digits
/// themselves. The actual PIN value lives in the parent's local state and is
/// never passed here.
///
/// [error] tints the dots crimson (wrong PIN feedback); the dots otherwise sit
/// hollow (unfilled) → brand-filled (filled).
class BbPinView extends StatelessWidget {
  const BbPinView({
    super.key,
    required this.length,
    required this.filled,
    this.error = false,
  });

  /// Total PIN length (number of dots).
  final int length;

  /// How many dots are filled (digits entered so far).
  final int filled;

  /// Tint the dots to signal a wrong PIN.
  final bool error;

  @override
  Widget build(BuildContext context) {
    final Color on = error ? AppColors.danger : AppColors.brand;
    final Color off = AppColors.borderStrong;
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: <Widget>[
        for (int i = 0; i < length; i++)
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s2),
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 120),
              width: AppSpacing.s4,
              height: AppSpacing.s4,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: i < filled ? on : Colors.transparent,
                border: Border.all(
                  color: i < filled ? on : off,
                  width: 2,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

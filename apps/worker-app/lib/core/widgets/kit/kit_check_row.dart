import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// A full-width fact row with a green check — the spec §4 'CONTROLLERS KNOWN'
/// list, where each value is too long to read as a chip.
///
/// Read-only: it states a fact the worker already gave, so it is not a control
/// and owes no touch target.
class KitCheckRow extends StatelessWidget {
  const KitCheckRow({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: OnboardingColors.rowBg,
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        border: Border.all(color: OnboardingColors.borderSubtle),
      ),
      child: Row(
        children: <Widget>[
          Expanded(
            child: Text(
              label,
              style: OnboardingTypography.inter(
                size: 13,
                weight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(width: 8),
          const Icon(
            Icons.check_rounded,
            size: 16,
            color: OnboardingColors.successGreen,
          ),
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_chip.dart';
import 'bb_field_error.dart';

/// A labelled single-select drawn as aligned kit chips — the JUL31 pattern for
/// enum choices on the posting forms; the picked option flips to a solid haldi
/// pill. One copy for Post a job and both Edit screens, which each used to
/// carry their own.
///
/// [value] is nullable so a REQUIRED enum can start unpicked: no chip is
/// selected until the payer taps one — which is what keeps a default off the
/// worker's card. [errorText] shows under the chips (#2595).
class BbChipSelect<T extends Object> extends StatelessWidget {
  const BbChipSelect({
    super.key,
    required this.label,
    required this.value,
    required this.options,
    required this.labelOf,
    required this.onSelected,
    this.errorText,
  });

  final String label;
  final T? value;
  final List<T> options;
  final String Function(T) labelOf;
  final ValueChanged<T> onSelected;

  /// Inline error under the chips, or null.
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          label,
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
            color: AppColors.textPrimary,
          ),
        ),
        const SizedBox(height: AppSpacing.s2),
        Wrap(
          spacing: AppSpacing.s2,
          runSpacing: AppSpacing.s2,
          children: <Widget>[
            for (final T option in options)
              BbChip(
                label: labelOf(option),
                selected: option == value,
                onTap: () => onSelected(option),
              ),
          ],
        ),
        BbFieldError(text: errorText),
      ],
    );
  }
}

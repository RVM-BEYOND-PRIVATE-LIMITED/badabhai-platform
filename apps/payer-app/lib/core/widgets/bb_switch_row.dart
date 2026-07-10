import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// A labelled toggle row — `.bb-switch`. Title (+ optional muted suffix) on the
/// left, a themed [Switch] on the right; the whole row is at least 48px tall.
/// Used for the "Boost this posting" toggle on Post-a-job.
class BbSwitchRow extends StatelessWidget {
  const BbSwitchRow({
    super.key,
    required this.title,
    this.suffix,
    required this.value,
    required this.onChanged,
  });

  final String title;
  final String? suffix;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () => onChanged(!value),
      borderRadius: BorderRadius.circular(AppRadii.md),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: AppSpacing.tap),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.s1),
          child: Row(
            children: <Widget>[
              Expanded(
                child: RichText(
                  text: TextSpan(
                    text: title,
                    style: AppTypography.body(
                      size: AppTypography.sizeBase,
                      weight: FontWeight.w600,
                    ),
                    children: <InlineSpan>[
                      if (suffix != null)
                        TextSpan(
                          text: ' $suffix',
                          style: AppTypography.body(
                            size: AppTypography.sizeSm,
                            color: AppColors.textMuted,
                          ),
                        ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.s3),
              Switch(
                value: value,
                onChanged: onChanged,
                activeColor: AppColors.textOnBrand,
                activeTrackColor: AppColors.success,
                inactiveThumbColor: AppColors.paper0,
                inactiveTrackColor: AppColors.borderStrong,
                trackOutlineColor:
                    const WidgetStatePropertyAll<Color>(Colors.transparent),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// The kit's `BBOtpRow` — a display-only row of underline OTP slots (the Indian
/// bank convention: no boxes, just underlines). Each slot is a 2.5px bottom
/// border that turns **blue** once its digit is entered; empty slots stay on the
/// [AppColors.disabled] hairline. A filled slot shows a bullet (the digit is
/// never rendered back — this is a progress/affordance strip, not the field).
///
/// Wire the actual capture with a hidden [TextField]/focus controller in the OTP
/// screen and drive [filled] from its value length.
class BbOtpRow extends StatelessWidget {
  const BbOtpRow({super.key, required this.length, this.filled = 0});

  /// Number of slots (e.g. 4 or 6).
  final int length;

  /// How many leading slots are filled — drives the blue underline + bullet.
  final int filled;

  @override
  Widget build(BuildContext context) {
    return Row(
      children: List<Widget>.generate(length, (int i) {
        final bool active = i < filled;
        return Expanded(
          child: Container(
            margin: EdgeInsets.only(
              right: i == length - 1 ? 0 : AppSpacing.s2,
            ),
            padding: const EdgeInsets.only(bottom: AppSpacing.s1),
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: active ? AppColors.blue : AppColors.disabled,
                  width: 2.5,
                ),
              ),
            ),
            alignment: Alignment.center,
            child: Text(
              active ? '•' : ' ',
              style: AppTypography.display(
                size: 20,
                weight: FontWeight.w800,
                color: AppColors.textPrimary,
              ),
            ),
          ),
        );
      }),
    );
  }
}

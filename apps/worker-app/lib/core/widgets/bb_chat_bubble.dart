import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// A single chat message bubble for the "bada bhai" profiling chat.
///
/// Worker messages sit right on a soft green tint (the worker's own voice);
/// bada bhai sits left on crisp white with a warm hairline. One corner is
/// squared toward the speaker so the thread reads naturally.
class BbChatBubble extends StatelessWidget {
  const BbChatBubble({
    super.key,
    required this.text,
    required this.fromWorker,
  });

  final String text;
  final bool fromWorker;

  @override
  Widget build(BuildContext context) {
    const Radius soft = Radius.circular(AppRadii.lg);
    const Radius tight = Radius.circular(AppRadii.xs);

    return Align(
      alignment: fromWorker ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 300),
        margin: const EdgeInsets.symmetric(vertical: AppSpacing.s1),
        padding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.s4,
          vertical: AppSpacing.s3,
        ),
        decoration: BoxDecoration(
          color: fromWorker ? AppColors.green50 : AppColors.surfaceCard,
          border: Border.all(
            color: fromWorker ? AppColors.green100 : AppColors.borderSubtle,
          ),
          borderRadius: BorderRadius.only(
            topLeft: soft,
            topRight: soft,
            bottomLeft: fromWorker ? soft : tight,
            bottomRight: fromWorker ? tight : soft,
          ),
        ),
        child: Text(
          text,
          style: AppTypography.body(
            size: AppTypography.sizeMd,
            color: AppColors.textPrimary,
          ),
        ),
      ),
    );
  }
}

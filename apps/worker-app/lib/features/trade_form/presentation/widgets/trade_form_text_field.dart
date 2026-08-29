import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';

/// A themed text field for the trade form. Deliberately its OWN small widget
/// rather than an import of `features/finishing`'s `FinishingTextField`
/// (same look, same behaviour) — `features/finishing/` is out of scope for
/// this change (#1341) and slated for retirement (#1344); this scoped
/// duplicate keeps the trade form from depending on code already scheduled to
/// disappear. A persistent [Semantics] label keeps TalkBack meaningful after
/// the hint disappears on input (low-literacy accessibility).
class TradeFormTextField extends StatelessWidget {
  const TradeFormTextField({
    super.key,
    required this.controller,
    required this.hint,
    this.label,
    this.onChanged,
    this.onSubmitted,
    this.textInputAction = TextInputAction.next,
    this.keyboardType,
    this.maxLength,
    this.maxLines = 1,
  });

  final TextEditingController controller;
  final String hint;
  final String? label;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  final TextInputAction textInputAction;
  final TextInputType? keyboardType;
  final int? maxLength;
  final int maxLines;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label ?? hint,
      textField: true,
      child: TextField(
        controller: controller,
        onChanged: onChanged,
        onSubmitted: onSubmitted,
        textInputAction: textInputAction,
        keyboardType: keyboardType,
        maxLength: maxLength,
        maxLines: maxLines,
        style: AppTypography.body(size: AppTypography.sizeBase),
        decoration: InputDecoration(
          hintText: hint,
          filled: true,
          fillColor: AppColors.surfaceCard,
          counterText: maxLength == null ? null : '',
          hintStyle: AppTypography.body(
              size: AppTypography.sizeBase, color: AppColors.textFaint),
          contentPadding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.s3, vertical: AppSpacing.s3),
          enabledBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppRadii.md),
            borderSide: const BorderSide(color: AppColors.borderSubtle),
          ),
          focusedBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppRadii.md),
            borderSide: const BorderSide(color: AppColors.blue, width: 1.5),
          ),
        ),
      ),
    );
  }
}

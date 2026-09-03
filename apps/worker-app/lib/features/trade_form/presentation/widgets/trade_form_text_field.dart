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
    this.errorText,
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

  /// Inline validation message shown under the field, in place of the
  /// hint/counter — e.g. a "kis saal" year field rejecting a future year.
  /// Null (the default) renders exactly as before.
  final String? errorText;

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
          errorText: errorText,
          filled: true,
          fillColor: AppColors.surfaceCard,
          counterText: maxLength == null ? null : '',
          hintStyle: AppTypography.body(
              size: AppTypography.sizeBase, color: AppColors.textFaint),
          errorStyle: AppTypography.body(
              size: AppTypography.sizeXs, color: AppColors.danger),
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
          errorBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppRadii.md),
            borderSide: const BorderSide(color: AppColors.danger, width: 1.5),
          ),
          focusedErrorBorder: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppRadii.md),
            borderSide: const BorderSide(color: AppColors.danger, width: 1.5),
          ),
        ),
      ),
    );
  }
}

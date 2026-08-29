import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// The app's one token-driven search input — lifted verbatim from
/// `JobSearchScreen._field` (#1342) so every screen that needs a "type to
/// filter" box shares the same look instead of re-declaring its own
/// [InputDecoration]: white [AppColors.surfaceCard] fill, [AppRadii.md]
/// corners, a hairline border that turns blue (1.5px) on focus, a leading
/// search icon, and [AppSpacing.controlLg] height — the worker app's large
/// control token, sized well above the 48px touch-target floor.
///
/// Purely a text input: it has no notion of what it filters. Pair it with
/// [BbSearchableMultiSelect] (or a screen's own list) via [onChanged].
class BbSearchField extends StatelessWidget {
  const BbSearchField({
    super.key,
    this.controller,
    this.label = 'Search karein',
    this.hint = 'Type karke dhoondein',
    this.onChanged,
    this.fieldKey,
    this.autofocus = false,
  });

  /// Text controller. When omitted, the field manages its own (uncontrolled).
  final TextEditingController? controller;

  /// The persistent accessible name — announced by TalkBack even once the
  /// [hint] has disappeared behind typed text (mirrors the job-search field's
  /// own reasoning: the hint alone leaves low-literacy / screen-reader users
  /// without a name for the field mid-input).
  final String label;

  /// Placeholder shown before any input.
  final String hint;

  final ValueChanged<String>? onChanged;

  final Key? fieldKey;

  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      label: label,
      textField: true,
      child: SizedBox(
        height: AppSpacing.controlLg,
        child: TextField(
          key: fieldKey,
          controller: controller,
          onChanged: onChanged,
          autofocus: autofocus,
          textInputAction: TextInputAction.search,
          style: AppTypography.body(size: AppTypography.sizeMd),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textFaint,
            ),
            prefixIcon: const Icon(
              Icons.search,
              size: 20,
              color: AppColors.textMuted,
            ),
            isDense: true,
            filled: true,
            fillColor: AppColors.surfaceCard,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: AppSpacing.s3,
              vertical: AppSpacing.s2,
            ),
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
      ),
    );
  }
}

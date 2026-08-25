import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show TextInputFormatter;

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// Focus = a deep-blue hairline (kit law: haldi is a fill, blue carries
/// structure / focus). Overrides the theme's default focus edge on these form
/// primitives so a focused field reads as "active/trusted", never haldi text.
final OutlineInputBorder _kFocusBorder = OutlineInputBorder(
  borderRadius: BorderRadius.circular(AppRadii.md),
  borderSide: const BorderSide(color: AppColors.blue, width: 2),
);

/// A labelled form field — `.bb-field` + `.bb-input`. A bold label over a
/// themed [TextField] (the input chrome comes from [AppTheme]'s
/// `inputDecorationTheme`); paper fill, 1px hairline, radius 10, and a deep-blue
/// focus border. Optional leading [icon] for the phone/search inputs.
///
/// [mono] renders the value in Roboto Mono (the phone field).
class BbField extends StatelessWidget {
  const BbField({
    super.key,
    this.label,
    this.controller,
    this.hint,
    this.icon,
    this.keyboardType,
    this.mono = false,
    this.readOnly = false,
    this.fieldKey,
    this.autofillHints,
    this.prefixText,
    this.inputFormatters,
    this.suppressSuggestions = false,
  });

  final String? label;
  final TextEditingController? controller;
  final String? hint;
  final IconData? icon;
  final TextInputType? keyboardType;
  final bool mono;
  final bool readOnly;
  final Key? fieldKey;

  /// Fixed leading chrome inside the field (e.g. `+91` on the phone input). The
  /// controller then holds only what the user types after it, so the prefix can
  /// never be edited or lost. Null for ordinary fields.
  final String? prefixText;

  /// Input formatters (e.g. digits-only + length cap on the phone field). Null
  /// leaves the field unconstrained.
  final List<TextInputFormatter>? inputFormatters;

  /// OS autofill hints (e.g. `[AutofillHints.oneTimeCode]` on an OTP field so the
  /// keyboard can surface the code). Null for ordinary fields.
  final List<String>? autofillHints;

  /// Suppress the keyboard's autocorrect, suggestion strip, AND personalized
  /// learning for this field. Use on IDENTITY free-text inputs — a company /
  /// agency name — where the IME must NOT offer a value the user typed in some
  /// OTHER app before (Gboard's personalized learning would otherwise resurface a
  /// stale org name on a blank signup field). Autofill is already off on these
  /// fields (no `autofillHints` → `AutofillConfiguration.disabled`); this closes
  /// the IME-learning path too. Default false leaves ordinary fields untouched.
  final bool suppressSuggestions;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (label != null) ...<Widget>[
          Text(
            label!,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
        ],
        TextField(
          key: fieldKey,
          controller: controller,
          readOnly: readOnly,
          keyboardType: keyboardType,
          autofillHints: autofillHints,
          inputFormatters: inputFormatters,
          // Identity fields turn all three OFF so the keyboard cannot resurface a
          // value the user typed in another app (e.g. an old company name).
          autocorrect: !suppressSuggestions,
          enableSuggestions: !suppressSuggestions,
          enableIMEPersonalizedLearning: !suppressSuggestions,
          style: mono
              ? AppTypography.mono(size: AppTypography.sizeBase, weight: FontWeight.w600)
              : AppTypography.body(size: AppTypography.sizeBase),
          decoration: InputDecoration(
            hintText: hint,
            prefixIcon: icon == null
                ? null
                : Icon(icon, size: 20, color: AppColors.textMuted),
            prefixText: prefixText,
            prefixStyle: prefixText == null
                ? null
                : AppTypography.mono(
                    size: AppTypography.sizeBase,
                    weight: FontWeight.w600,
                  ),
            focusedBorder: _kFocusBorder,
          ),
        ),
      ],
    );
  }
}

/// A themed dropdown — `.bb-select`. Mirrors [BbField]'s label + chrome.
class BbSelect<T> extends StatelessWidget {
  const BbSelect({
    super.key,
    this.label,
    required this.value,
    required this.items,
    required this.onChanged,
    required this.labelOf,
  });

  final String? label;
  final T value;
  final List<T> items;
  final ValueChanged<T?> onChanged;
  final String Function(T) labelOf;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        if (label != null) ...<Widget>[
          Text(
            label!,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: AppSpacing.s2),
        ],
        DropdownButtonFormField<T>(
          initialValue: value,
          isExpanded: true,
          decoration: InputDecoration(focusedBorder: _kFocusBorder),
          icon: const Icon(Icons.expand_more, color: AppColors.textMuted),
          style: AppTypography.body(size: AppTypography.sizeBase),
          items: items
              .map(
                (T item) => DropdownMenuItem<T>(
                  value: item,
                  child: Text(labelOf(item)),
                ),
              )
              .toList(growable: false),
          onChanged: onChanged,
        ),
      ],
    );
  }
}

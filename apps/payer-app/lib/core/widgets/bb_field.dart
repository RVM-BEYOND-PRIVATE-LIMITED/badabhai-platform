import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// A labelled form field — `.bb-field` + `.bb-input`. A bold label over a
/// themed [TextField] (the input chrome comes from [AppTheme]'s
/// `inputDecorationTheme`). Optional leading [icon] for the phone/search inputs.
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
  });

  final String? label;
  final TextEditingController? controller;
  final String? hint;
  final IconData? icon;
  final TextInputType? keyboardType;
  final bool mono;
  final bool readOnly;
  final Key? fieldKey;

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
          style: mono
              ? AppTypography.mono(size: AppTypography.sizeBase, weight: FontWeight.w600)
              : AppTypography.body(size: AppTypography.sizeBase),
          decoration: InputDecoration(
            hintText: hint,
            prefixIcon: icon == null
                ? null
                : Icon(icon, size: 20, color: AppColors.textMuted),
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

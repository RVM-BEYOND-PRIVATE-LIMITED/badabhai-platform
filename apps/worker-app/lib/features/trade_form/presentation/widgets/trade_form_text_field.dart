import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/devanagari_guard.dart';

/// A themed text field for the trade form. Deliberately its OWN small widget
/// rather than an import of `features/finishing`'s `FinishingTextField`
/// (same look, same behaviour) — `features/finishing/` is out of scope for
/// this change (#1341) and slated for retirement (#1344); this scoped
/// duplicate keeps the trade form from depending on code already scheduled to
/// disappear. A persistent [Semantics] label keeps TalkBack meaningful after
/// the hint disappears on input (low-literacy accessibility).
///
/// EVERY trade-form free-text field routes through here (employer/role/work
/// text, certificate name/issuer, education field/institute, the generic
/// open-answer question box) — so [DevanagariBlockFormatter] lives here once,
/// centrally, rather than at each of the ~15 call sites. No resume-rendering
/// step transliterates Devanagari today (see #1411), so a worker typing in
/// Hindi script would otherwise get an unromanized line on their printed
/// resume with no warning — this stops the character at the keyboard instead.
class TradeFormTextField extends StatefulWidget {
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
  /// Null (the default) renders exactly as before. Takes priority over the
  /// Devanagari-blocked hint when both would otherwise show — a caller's own
  /// validation message is more specific to what the worker is doing right
  /// now.
  final String? errorText;

  @override
  State<TradeFormTextField> createState() => _TradeFormTextFieldState();
}

class _TradeFormTextFieldState extends State<TradeFormTextField> {
  /// Sticky for this field's lifetime once a worker's Devanagari keystroke
  /// gets stripped — the hint stays up rather than flickering in and out per
  /// keystroke, so it reads as guidance rather than a per-character scold.
  bool _devanagariBlocked = false;

  @override
  Widget build(BuildContext context) {
    final String? effectiveErrorText =
        widget.errorText ?? (_devanagariBlocked ? kDevanagariBlockedHint : null);
    return Semantics(
      label: widget.label ?? widget.hint,
      textField: true,
      child: TextField(
        controller: widget.controller,
        onChanged: widget.onChanged,
        onSubmitted: widget.onSubmitted,
        textInputAction: widget.textInputAction,
        keyboardType: widget.keyboardType,
        maxLength: widget.maxLength,
        maxLines: widget.maxLines,
        inputFormatters: <TextInputFormatter>[
          DevanagariBlockFormatter(
            onBlocked: () => setState(() => _devanagariBlocked = true),
          ),
        ],
        style: AppTypography.body(size: AppTypography.sizeBase),
        decoration: InputDecoration(
          hintText: widget.hint,
          errorText: effectiveErrorText,
          filled: true,
          fillColor: AppColors.surfaceCard,
          counterText: widget.maxLength == null ? null : '',
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

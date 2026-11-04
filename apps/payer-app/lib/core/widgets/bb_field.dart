import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show TextInputFormatter;

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import 'bb_field_error.dart';
import 'bb_focus_chain.dart';

/// Focus = a deep-blue hairline (kit law: haldi is a fill, blue carries
/// structure / focus). Overrides the theme's default focus edge on these form
/// primitives so a focused field reads as "active/trusted", never haldi text.
final OutlineInputBorder _kFocusBorder = OutlineInputBorder(
  borderRadius: BorderRadius.circular(AppRadii.md),
  borderSide: const BorderSide(color: AppColors.blue, width: 2),
);

/// The input edge for a field with an inline error — the theme's own crimson
/// `errorBorder` / `focusedErrorBorder`, so an invalid box reads as invalid at
/// a glance (no new colour: it is the theme's error chrome, applied here
/// because the error TEXT is drawn by [BbFieldError], not by Material).
({InputBorder? enabled, InputBorder? focused}) _errorBorders(
  BuildContext context,
  bool hasError,
) {
  if (!hasError) return (enabled: null, focused: _kFocusBorder);
  final InputDecorationThemeData theme =
      Theme.of(context).inputDecorationTheme;
  return (enabled: theme.errorBorder, focused: theme.focusedErrorBorder);
}

/// A labelled form field — `.bb-field` + `.bb-input`. A bold label over a
/// themed [TextField] (the input chrome comes from [AppTheme]'s
/// `inputDecorationTheme`); paper fill, 1px hairline, radius 10, and a deep-blue
/// focus border. Optional leading [icon] for the phone/search inputs.
///
/// [mono] renders the value in Roboto Mono (the phone field).
///
/// #2595 — [errorText] shows the field's inline error under the input (and
/// edges the box in the theme's error crimson); [flow] places it in a form's
/// keyboard "next"/"done" chain ([BbFocusChain]).
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
    this.minLines,
    this.maxLines = 1,
    this.obscureText = false,
    this.suffixIcon,
    this.onChanged,
    this.errorText,
    this.flow,
    this.focusNode,
    this.textInputAction,
    this.onSubmitted,
    this.autofocus = false,
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

  /// Line bounds for a MULTILINE input (a job description). Both null-safe
  /// pass-throughs to [TextField]: the default `maxLines: 1` keeps every
  /// existing single-line field byte-identical, and a caller that wants a
  /// growing box passes e.g. `minLines: 3, maxLines: 6`. Additive only — no new
  /// token, no chrome change (the box grows inside the same hairline field).
  final int? minLines;
  final int? maxLines;

  /// Masks the value (passwords). Pair with [suffixIcon] for a show/hide toggle.
  final bool obscureText;

  /// Optional trailing control inside the field (e.g. the password eye).
  final Widget? suffixIcon;

  /// Fires on every edit (a controlled caller mirrors the value back).
  final ValueChanged<String>? onChanged;

  /// The field's inline error (#2595), shown under the input — null for none.
  final String? errorText;

  /// This input's place in a form's keyboard chain: its focus node, the
  /// "next"/"done" key, and where that key goes. Null keeps the defaults.
  final BbFieldFlow? flow;

  /// The input's own focus node when it is not in a [flow] chain — for a
  /// caller that manages focus itself. A [flow]'s node wins when both are set.
  final FocusNode? focusNode;

  /// The keyboard action key when the field is not in a [flow] chain (e.g.
  /// "done" on a one-field dialog, paired with [onSubmitted]).
  final TextInputAction? textInputAction;

  /// Fires when the keyboard action key is pressed (outside a [flow] chain).
  final ValueChanged<String>? onSubmitted;

  /// Focus the input as it appears (a search box opened to be typed in).
  final bool autofocus;

  @override
  Widget build(BuildContext context) {
    final BbFieldFlow? flow = this.flow;
    final ({InputBorder? enabled, InputBorder? focused}) borders =
        _errorBorders(context, errorText != null);
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
          focusNode: flow?.focusNode ?? focusNode,
          textInputAction: flow?.action ?? textInputAction,
          onEditingComplete: flow?.onAction,
          onSubmitted: flow == null ? onSubmitted : null,
          autofocus: autofocus,
          readOnly: readOnly,
          keyboardType: keyboardType,
          minLines: minLines,
          maxLines: maxLines,
          obscureText: obscureText,
          onChanged: onChanged,
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
            suffixIcon: suffixIcon,
            prefixText: prefixText,
            prefixStyle: prefixText == null
                ? null
                : AppTypography.mono(
                    size: AppTypography.sizeBase,
                    weight: FontWeight.w600,
                  ),
            enabledBorder: borders.enabled,
            focusedBorder: borders.focused,
          ),
        ),
        BbFieldError(text: errorText),
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
    this.errorText,
  });

  final String? label;
  final T value;
  final List<T> items;
  final ValueChanged<T?> onChanged;
  final String Function(T) labelOf;

  /// The select's inline error (#2595), shown under it — null for none.
  final String? errorText;

  @override
  Widget build(BuildContext context) {
    final ({InputBorder? enabled, InputBorder? focused}) borders =
        _errorBorders(context, errorText != null);
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
          decoration: InputDecoration(
            enabledBorder: borders.enabled,
            focusedBorder: borders.focused,
          ),
          icon: const Icon(Icons.expand_more_rounded, color: AppColors.textMuted),
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
        BbFieldError(text: errorText),
      ],
    );
  }
}

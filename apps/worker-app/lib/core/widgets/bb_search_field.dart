import 'package:flutter/material.dart';

import '../theme/bb_palette.dart';
import '../theme/onboarding_theme.dart';

/// The app's one token-driven search input: a white fill, 10dp corners, a
/// hairline that rings NAVY at 1.8 on focus (spec §3.3), a leading search
/// glyph, and a 48dp height — the worker-app touch floor.
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
  /// [hint] has disappeared behind typed text (the hint alone leaves
  /// low-literacy / screen-reader users without a name for the field
  /// mid-input).
  final String label;

  /// Placeholder shown before any input.
  final String hint;

  final ValueChanged<String>? onChanged;

  final Key? fieldKey;

  final bool autofocus;

  static OutlineInputBorder _border(Color color, double width) =>
      OutlineInputBorder(
        borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
        borderSide: BorderSide(color: color, width: width),
      );

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    return Semantics(
      label: label,
      textField: true,
      child: SizedBox(
        height: OnboardingLayout.tapTarget,
        child: TextField(
          key: fieldKey,
          controller: controller,
          onChanged: onChanged,
          autofocus: autofocus,
          textInputAction: TextInputAction.search,
          style: OnboardingTypography.inter(size: 14, weight: FontWeight.w500),
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: OnboardingTypography.inter(
              size: 14,
              color: p.textMuted,
            ),
            // Icons.search, not the rounded variant: bb_search_field_test
            // asserts this exact glyph.
            prefixIcon: Icon(Icons.search, size: 20, color: p.textMuted),
            isDense: true,
            filled: true,
            fillColor: p.card,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 12,
              vertical: 8,
            ),
            enabledBorder: _border(p.borderDefault, 1.2),
            border: _border(p.borderDefault, 1.2),
            focusedBorder: _border(p.focusRing, 1.8),
          ),
        ),
      ),
    );
  }
}

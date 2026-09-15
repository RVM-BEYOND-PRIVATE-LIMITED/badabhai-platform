import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/onboarding/option_icons.dart';

// Copy. aap-form, no `!`, safe verbs only. Scanned by
// persona_neutrality_test.dart.

/// The multi-select hint pill under a question (Workholding / Measuring /
/// Operations mockups) — shared by the question screen and the marker pages'
/// multi-select groups so the two never drift apart.
const String kTradeFormMultiSelectHint = 'Multiple options select kar sakte hain';

/// The icon tile for a MARKER page's option card.
///
/// The marker lists (languages, documents, shift, salary band, credential,
/// council) are closed sets from the preferences/qualifications vocabularies,
/// not question-pack options, so the shared rules in `option_icons.dart`
/// mostly do not recognise them and fall through to their neutral default. On
/// these pages that default is replaced by [fallback] — an icon for what the
/// whole list is about — so a language list reads as languages rather than as
/// a column of generic tags. A rule that DOES recognise the option still wins.
IconData tradeFormOptionIcon({
  required String optionKey,
  required String label,
  required IconData fallback,
}) {
  final IconData neutral = iconForQuestion(null);
  final IconData icon = iconForOption(optionKey: optionKey, label: label);
  return icon == neutral ? fallback : icon;
}

/// The trade form's LOCAL compositions of the Master Flutter UI Kit.
///
/// The shared kit (`lib/core/widgets/onboarding/`) ships the Shift Blue header,
/// the docked bottom bar, the option cards, the hero CTA and the select field.
/// The trade form's marker pages also need a few pieces the kit does not carry
/// — a kit-styled input decoration, a secondary outline button, a pill chip, a
/// switch row, a white card shell — and all three marker pages need the SAME
/// ones. They are composed here, once, from the kit's own tokens, rather than
/// in `lib/core/` (which this feature does not own) or three times over.
///
/// Nothing here carries behaviour of its own: every widget is a paint over a
/// callback its caller already owned before the redesign.

/// The kit's input look — white, 10 radius, 1.2px `borderDefault`, the yellow
/// `borderActive` focus ring, Inter — as an [InputDecoration], shared by
/// [TradeFormTextField] and the question screen's search box so the two can
/// never drift apart.
InputDecoration tradeFormInputDecoration({
  required String hint,
  String? errorText,
  Widget? prefixIcon,
  String? counterText,
}) {
  OutlineInputBorder border(Color color, double width) => OutlineInputBorder(
        borderRadius: BorderRadius.circular(OnboardingRadii.nameField),
        borderSide: BorderSide(color: color, width: width),
      );
  return InputDecoration(
    hintText: hint,
    errorText: errorText,
    counterText: counterText,
    prefixIcon: prefixIcon,
    filled: true,
    fillColor: OnboardingColors.paperWhite,
    hintStyle: OnboardingTypography.inter(
      size: 14,
      color: OnboardingColors.ink500,
    ),
    errorStyle: OnboardingTypography.inter(
      size: 12,
      color: OnboardingColors.errorRed,
    ),
    // A long Hinglish validation line must wrap, not ellipsize, on a 320dp
    // handset — the worker needs the whole reason.
    errorMaxLines: 3,
    contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 15),
    border: border(OnboardingColors.borderDefault, 1.2),
    enabledBorder: border(OnboardingColors.borderDefault, 1.2),
    focusedBorder: border(OnboardingColors.borderActive, 1.5),
    errorBorder: border(OnboardingColors.errorRed, 1.5),
    focusedErrorBorder: border(OnboardingColors.errorRed, 1.5),
    disabledBorder: border(OnboardingColors.borderSubtle, 1.2),
  );
}

/// A marker page's question heading, drawn like the question screen's own
/// intro: the form-flow headline, with an optional why-style line under it.
class TradeFormHeading extends StatelessWidget {
  const TradeFormHeading({super.key, required this.title, this.subtitle});

  final String title;
  final String? subtitle;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Text(title, style: OnboardingTypography.formQuestionHeadline()),
        if (subtitle != null && subtitle!.isNotEmpty) ...<Widget>[
          const SizedBox(height: FormFlowLayout.headlineToWhyGap),
          Text(subtitle!, style: OnboardingTypography.formWhyText()),
        ],
      ],
    );
  }
}

/// The small Inter label above a kit input. Rendered as written (not
/// upper-cased) — the text is also what screen readers and tests read.
class TradeFormFieldLabel extends StatelessWidget {
  const TradeFormFieldLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Text(
        text,
        style: OnboardingTypography.inter(
          size: 13,
          weight: FontWeight.w600,
          color: OnboardingColors.ink600,
        ),
      ),
    );
  }
}

/// A full-width white outline button — the kit's secondary action (e.g. "add
/// another", "retry") that must not compete with the docked yellow bar.
class TradeFormSecondaryButton extends StatelessWidget {
  const TradeFormSecondaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: double.infinity,
      child: OutlinedButton(
        onPressed: onPressed,
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(0, OnboardingLayout.tapTarget),
          backgroundColor: OnboardingColors.paperWhite,
          foregroundColor: OnboardingColors.shiftBlue,
          side: const BorderSide(
            color: OnboardingColors.borderDefault,
            width: 1.2,
          ),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(12),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (icon != null) ...<Widget>[
              Icon(icon, size: 20, color: OnboardingColors.shiftBlue),
              const SizedBox(width: 8),
            ],
            Flexible(
              child: Text(
                label,
                textAlign: TextAlign.center,
                style: OnboardingTypography.anek(
                  size: 15,
                  weight: FontWeight.w700,
                  color: OnboardingColors.shiftBlue,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A tappable pill — the trade form's quick-pick chip (city suggestions, a
/// picked city, certificate-name suggestions, the year/month sheet). Selected
/// reads like a selected kit card: yellow border on `selectedCardBg`. The tap
/// area is always at least [OnboardingLayout.tapTarget] tall.
class TradeFormPillChip extends StatelessWidget {
  const TradeFormPillChip({
    super.key,
    required this.label,
    required this.onTap,
    this.selected = false,
    this.leadingIcon,
    this.trailingIcon,
    this.labelStyle,
  });

  final String label;
  final VoidCallback? onTap;
  final bool selected;

  /// A small glyph before the label — the option-list chips (city and
  /// certificate suggestions) carry one, like the option cards' icon tiles.
  final IconData? leadingIcon;
  final IconData? trailingIcon;

  /// Overrides the Inter label — e.g. Roboto Mono for a year.
  final TextStyle? labelStyle;

  @override
  Widget build(BuildContext context) {
    final BorderRadius radius = BorderRadius.circular(OnboardingRadii.badge);
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected
            ? OnboardingColors.selectedCardBg
            : OnboardingColors.paperWhite,
        borderRadius: radius,
        child: InkWell(
          onTap: onTap,
          borderRadius: radius,
          child: Container(
            constraints:
                const BoxConstraints(minHeight: OnboardingLayout.tapTarget),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            decoration: BoxDecoration(
              borderRadius: radius,
              border: Border.all(
                color: selected
                    ? OnboardingColors.safetyYellow
                    : OnboardingColors.borderDefault,
                width: selected ? 1.8 : 1.2,
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                if (leadingIcon != null) ...<Widget>[
                  Icon(
                    leadingIcon,
                    size: 16,
                    color: OnboardingColors.shiftBlue,
                  ),
                  const SizedBox(width: 6),
                ],
                Flexible(
                  child: Text(
                    label,
                    style: labelStyle ??
                        OnboardingTypography.inter(
                          size: 14,
                          weight: FontWeight.w600,
                        ),
                  ),
                ),
                if (trailingIcon != null) ...<Widget>[
                  const SizedBox(width: 6),
                  Icon(
                    trailingIcon,
                    size: 18,
                    color: OnboardingColors.shiftBlue,
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// A white card row carrying a label and the kit's navy/yellow switch. The
/// whole row toggles; the label and the on/off state are announced together.
class TradeFormSwitchRow extends StatelessWidget {
  const TradeFormSwitchRow({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  static bool _on(Set<WidgetState> states) =>
      states.contains(WidgetState.selected);

  @override
  Widget build(BuildContext context) {
    final BorderRadius radius = BorderRadius.circular(14);
    return MergeSemantics(
      child: Material(
        color: OnboardingColors.paperWhite,
        borderRadius: radius,
        child: InkWell(
          onTap: () => onChanged(!value),
          borderRadius: radius,
          child: Container(
            constraints:
                const BoxConstraints(minHeight: OnboardingLayout.tapTarget),
            padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
            decoration: BoxDecoration(
              borderRadius: radius,
              border: Border.all(
                color: OnboardingColors.borderDefault,
                width: 1.2,
              ),
            ),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    label,
                    style: OnboardingTypography.inter(
                      size: 15,
                      weight: FontWeight.w600,
                    ),
                  ),
                ),
                const SizedBox(width: 8),
                Switch(
                  value: value,
                  onChanged: onChanged,
                  thumbColor: WidgetStateProperty.resolveWith(
                    (Set<WidgetState> s) => _on(s)
                        ? OnboardingColors.safetyYellow
                        : OnboardingColors.paperWhite,
                  ),
                  trackColor: WidgetStateProperty.resolveWith(
                    (Set<WidgetState> s) => _on(s)
                        ? OnboardingColors.shiftBlue
                        : OnboardingColors.disabledBg,
                  ),
                  trackOutlineColor: WidgetStateProperty.resolveWith(
                    (Set<WidgetState> s) => _on(s)
                        ? OnboardingColors.shiftBlue
                        : OnboardingColors.borderDefault,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// The white kit card that holds one repeatable entry (an employer, a
/// certificate, an education row), with an optional 48px remove button.
class TradeFormCard extends StatelessWidget {
  const TradeFormCard({
    super.key,
    required this.child,
    this.onRemove,
    this.removeTooltip,
  });

  final Widget child;
  final VoidCallback? onRemove;
  final String? removeTooltip;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: EdgeInsets.fromLTRB(16, onRemove == null ? 16 : 4, 16, 16),
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(color: OnboardingColors.borderDefault, width: 1.2),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (onRemove != null)
            Align(
              alignment: Alignment.centerRight,
              child: IconButton(
                onPressed: onRemove,
                tooltip: removeTooltip,
                icon: const Icon(
                  Icons.close,
                  size: 20,
                  color: OnboardingColors.ink500,
                ),
              ),
            ),
          child,
        ],
      ),
    );
  }
}

/// The in-body loading spinner, in the kit's navy.
class TradeFormSpinner extends StatelessWidget {
  const TradeFormSpinner({super.key});

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Padding(
        padding: EdgeInsets.all(24),
        child: CircularProgressIndicator(color: OnboardingColors.shiftBlue),
      ),
    );
  }
}

/// A failed options fetch: the real message, then a retry.
class TradeFormRetryBlock extends StatelessWidget {
  const TradeFormRetryBlock({
    super.key,
    required this.message,
    required this.retryLabel,
    required this.onRetry,
  });

  final String message;
  final String retryLabel;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(message, style: OnboardingTypography.body()),
        const SizedBox(height: 12),
        TradeFormSecondaryButton(label: retryLabel, onPressed: onRetry),
      ],
    );
  }
}

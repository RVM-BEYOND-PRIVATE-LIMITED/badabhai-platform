import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// Multi-select option card (master spec §2.3, rule 2 of §5): selected = yellow
/// 1.8px border on a warm `#FFFBEB` fill, with a navy-filled checkbox carrying a
/// yellow border and a yellow tick. Unselected = white with a 1.2px hairline and
/// an empty checkbox.
///
/// [OnboardingVariant.formFlow] draws the form-flow mockups' card (see
/// [FormFlowLayout]): content 16dp from the outer edge whatever the border
/// width, a 40dp tile with a slate glyph (navy once selected), an Anek navy
/// title, and a 24dp checkbox that is a plain navy fill once ticked.
class MultiSelectQuestionCard extends StatelessWidget {
  const MultiSelectQuestionCard({
    super.key,
    required this.title,
    this.subtitle,
    this.leadingIcon,
    required this.isSelected,
    required this.onTap,
    this.subtitleMono = false,
    this.variant = OnboardingVariant.standard,
  });

  /// Renders [subtitle] in Roboto Mono — for measurement specs such as
  /// "Standard linear measurement (0.02mm)".
  final bool subtitleMono;

  final String title;
  final String? subtitle;
  final IconData? leadingIcon;
  final bool isSelected;

  /// Null renders the card non-interactive (e.g. while a save is in flight).
  final VoidCallback? onTap;

  final OnboardingVariant variant;

  @override
  Widget build(BuildContext context) {
    return _SelectionCardShell(
      title: title,
      subtitle: subtitle,
      leadingIcon: leadingIcon,
      isSelected: isSelected,
      onTap: onTap,
      checked: isSelected,
      subtitleMono: subtitleMono,
      variant: variant,
      indicator: OptionCheckbox(isSelected: isSelected, variant: variant),
    );
  }
}

/// Single-select (radio) option card — the same card as
/// [MultiSelectQuestionCard], with a round indicator: selected = navy disc with
/// a yellow border and a yellow centre dot ([OnboardingVariant.formFlow]: no
/// border on the disc).
class SingleSelectQuestionCard extends StatelessWidget {
  const SingleSelectQuestionCard({
    super.key,
    required this.title,
    this.subtitle,
    this.leadingIcon,
    required this.isSelected,
    required this.onTap,
    this.subtitleMono = false,
    this.variant = OnboardingVariant.standard,
  });

  /// Renders [subtitle] in Roboto Mono — for measurement specs such as
  /// "Standard linear measurement (0.02mm)".
  final bool subtitleMono;

  final String title;
  final String? subtitle;
  final IconData? leadingIcon;
  final bool isSelected;
  final VoidCallback? onTap;

  final OnboardingVariant variant;

  @override
  Widget build(BuildContext context) {
    return _SelectionCardShell(
      title: title,
      subtitle: subtitle,
      leadingIcon: leadingIcon,
      isSelected: isSelected,
      onTap: onTap,
      checked: isSelected,
      subtitleMono: subtitleMono,
      inMutuallyExclusiveGroup: true,
      variant: variant,
      indicator: OptionRadio(isSelected: isSelected, variant: variant),
    );
  }
}

/// The square checkbox of a multi-select option. Paint only — the card owns
/// the tap and the semantics.
class OptionCheckbox extends StatelessWidget {
  const OptionCheckbox({
    super.key,
    required this.isSelected,
    this.variant = OnboardingVariant.standard,
  });

  final bool isSelected;
  final OnboardingVariant variant;

  @override
  Widget build(BuildContext context) {
    final bool form = variant == OnboardingVariant.formFlow;
    final double size = form ? FormFlowLayout.indicatorSize : 22;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: isSelected ? OnboardingColors.blueThemeDark : Colors.transparent,
        borderRadius: BorderRadius.circular(FormFlowLayout.checkboxRadius),
        border: _indicatorBorder(isSelected: isSelected, form: form),
      ),
      child: isSelected
          ? const Icon(
              Icons.check_rounded,
              size: 16,
              color: OnboardingColors.safetyYellow,
            )
          : null,
    );
  }
}

/// The round indicator of a single-select option. Paint only.
class OptionRadio extends StatelessWidget {
  const OptionRadio({
    super.key,
    required this.isSelected,
    this.variant = OnboardingVariant.standard,
  });

  final bool isSelected;
  final OnboardingVariant variant;

  @override
  Widget build(BuildContext context) {
    final bool form = variant == OnboardingVariant.formFlow;
    final double size = form ? FormFlowLayout.indicatorSize : 22;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: isSelected ? OnboardingColors.blueThemeDark : Colors.transparent,
        border: _indicatorBorder(isSelected: isSelected, form: form),
      ),
      alignment: Alignment.center,
      child: isSelected
          ? Container(
              width: 8,
              height: 8,
              decoration: const BoxDecoration(
                shape: BoxShape.circle,
                color: OnboardingColors.safetyYellow,
              ),
            )
          : null,
    );
  }
}

/// An empty indicator's grey ring; a selected one's yellow ring — which the
/// form flow drops, leaving the navy fill alone.
Border? _indicatorBorder({required bool isSelected, required bool form}) {
  if (isSelected && form) return null;
  return Border.all(
    color: isSelected
        ? OnboardingColors.safetyYellow
        : OnboardingColors.borderDefault,
    width: 1.8,
  );
}

/// The rounded icon tile at the start of an option card. Paint only.
class OptionIconTile extends StatelessWidget {
  const OptionIconTile({
    super.key,
    required this.icon,
    required this.isSelected,
    this.variant = OnboardingVariant.standard,
  });

  final IconData icon;
  final bool isSelected;
  final OnboardingVariant variant;

  @override
  Widget build(BuildContext context) {
    final bool form = variant == OnboardingVariant.formFlow;
    final double size = form ? FormFlowLayout.tileSize : 38;
    final Color glyph = form && !isSelected
        ? FormFlowColors.tileGlyph
        : OnboardingColors.shiftBlue;
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: isSelected
            ? OnboardingColors.safetyYellow.withValues(alpha: 0.2)
            : OnboardingColors.cardIconBg,
        borderRadius: BorderRadius.circular(
          form ? FormFlowLayout.tileRadius : 10,
        ),
      ),
      child: Icon(
        icon,
        size: FormFlowLayout.tileGlyphSize,
        color: glyph,
      ),
    );
  }
}

class _SelectionCardShell extends StatelessWidget {
  const _SelectionCardShell({
    required this.title,
    required this.subtitle,
    required this.leadingIcon,
    required this.isSelected,
    required this.onTap,
    required this.indicator,
    required this.checked,
    required this.variant,
    this.subtitleMono = false,
    this.inMutuallyExclusiveGroup = false,
  });

  final bool subtitleMono;

  final String title;
  final String? subtitle;
  final IconData? leadingIcon;
  final bool isSelected;
  final VoidCallback? onTap;
  final Widget indicator;
  final bool checked;
  final bool inMutuallyExclusiveGroup;
  final OnboardingVariant variant;

  @override
  Widget build(BuildContext context) {
    final bool form = variant == OnboardingVariant.formFlow;
    final BorderRadius radius =
        BorderRadius.circular(FormFlowLayout.cardRadius);
    final BorderSide side = BorderSide(
      color: isSelected
          ? OnboardingColors.safetyYellow
          : (form ? FormFlowColors.cardBorder : OnboardingColors.borderDefault),
      width: isSelected ? 1.8 : 1.2,
    );
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Semantics(
        button: true,
        checked: checked,
        inMutuallyExclusiveGroup: inMutuallyExclusiveGroup,
        child: Material(
          color: isSelected
              ? OnboardingColors.selectedCardBg
              : OnboardingColors.paperWhite,
          // The form flow paints its hairline on the Material's shape, which
          // takes no layout space: the content then sits exactly
          // [FormFlowLayout.cardInset] from the card's outer edge whether the
          // border is 1.2 or 1.8 wide. The standard card keeps its Container
          // border (which insets the content by the border width).
          shape: RoundedRectangleBorder(
            borderRadius: radius,
            side: form ? side : BorderSide.none,
          ),
          child: InkWell(
            onTap: onTap,
            borderRadius: radius,
            child: Container(
              constraints: const BoxConstraints(
                minHeight: OnboardingLayout.tapTarget,
              ),
              padding: form
                  ? const EdgeInsets.all(FormFlowLayout.cardInset)
                  : const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              decoration: form
                  ? null
                  : BoxDecoration(
                      borderRadius: radius,
                      border: Border.fromBorderSide(side),
                    ),
              child: Row(
                children: <Widget>[
                  if (leadingIcon != null) ...<Widget>[
                    OptionIconTile(
                      icon: leadingIcon!,
                      isSelected: isSelected,
                      variant: variant,
                    ),
                    SizedBox(width: form ? FormFlowLayout.tileToTitleGap : 14),
                  ],
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: <Widget>[
                        Text(
                          title,
                          style: form
                              ? OnboardingTypography.formCardTitle()
                              : OnboardingTypography.inter(
                                  size: 15,
                                  weight: FontWeight.w700,
                                ),
                        ),
                        if (subtitle != null && subtitle!.isNotEmpty) ...<Widget>[
                          const SizedBox(height: 3),
                          Text(subtitle!, style: _subtitleStyle(form)),
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(width: 10),
                  indicator,
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  TextStyle _subtitleStyle(bool form) {
    if (form) {
      return subtitleMono
          ? OnboardingTypography.formCardSubtitleMono()
          : OnboardingTypography.formCardSubtitle();
    }
    return subtitleMono
        ? OnboardingTypography.mono(
            size: 11,
            weight: FontWeight.w400,
            color: OnboardingColors.ink600,
          )
        : OnboardingTypography.inter(size: 12, color: OnboardingColors.ink600);
  }
}

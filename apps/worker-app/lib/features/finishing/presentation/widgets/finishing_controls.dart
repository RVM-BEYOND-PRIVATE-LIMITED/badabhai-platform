import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/widgets/onboarding/selection_cards.dart';

/// Small master-kit controls shared by the finishing form's pages and its
/// employer card. The shared kit (`core/widgets/onboarding/`) has no chip and no
/// switch, so they are composed here from [OnboardingColors] rather than pulled
/// from the JUL31 `BbChip` / `BbToggle`, whose haldi / green palette is not the
/// kit's.

/// A kit chip — `chipBg` + `borderDefault` hairline; selected = the kit's
/// selected-card treatment (yellow border on `#FFFBEB`). 48px tall so the chip
/// itself is the tap target. A long label (a typed city) wraps instead of
/// running off the screen.
class FinishingChip extends StatelessWidget {
  const FinishingChip({
    super.key,
    required this.label,
    this.selected = false,
    this.trailingIcon,
    this.labelStyle,
    required this.onTap,
  });

  final String label;
  final bool selected;
  final IconData? trailingIcon;
  final VoidCallback? onTap;

  /// Overrides the Inter label. Spec §1.2 puts counters, years and codes in
  /// Roboto Mono, so the year chips pass a mono style here — the same override
  /// the trade form's `TradeFormPillChip` already carries, so the two pickers
  /// cannot drift apart again.
  final TextStyle? labelStyle;

  static const double _radius = 12;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: selected
            ? OnboardingColors.selectedCardBg
            : OnboardingColors.chipBg,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(_radius),
          side: BorderSide(
            color: selected
                ? OnboardingColors.safetyYellow
                : OnboardingColors.borderDefault,
            width: selected ? 1.8 : 1.2,
          ),
        ),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(_radius),
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: OnboardingLayout.tapTarget,
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
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
                    Icon(trailingIcon,
                        size: 18, color: OnboardingColors.ink600),
                  ],
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A single-select option card for a TWO-PER-ROW grid cell.
///
/// WHY NOT THE KIT CARD. [SingleSelectQuestionCard] lays its icon tile, the
/// title and the radio in one row. In a two-up cell on a 360dp handset that
/// leaves ~39dp for the title, so "Diploma" breaks mid-word. One card per row
/// is not an option either: the education page's ten cards would push it far
/// past its one-short-flick bound (#1471). So a grid cell stacks the same parts
/// — the tile and the radio on top, the title beneath at full cell width — from
/// the form-flow card's own pieces ([OptionIconTile], [OptionRadio], the
/// form-flow title and hairline), with its selected treatment and semantics.
class FinishingGridOptionCard extends StatelessWidget {
  const FinishingGridOptionCard({
    super.key,
    required this.title,
    required this.icon,
    required this.isSelected,
    required this.onTap,
  });

  final String title;
  final IconData icon;
  final bool isSelected;
  final VoidCallback? onTap;

  /// Tighter than a full-width card's inset: a grid cell is half as wide.
  static const double _padding = 10;
  static const double _tileToTitleGap = 6;

  @override
  Widget build(BuildContext context) {
    final BorderRadius radius =
        BorderRadius.circular(FormFlowLayout.cardRadius);
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Semantics(
        button: true,
        checked: isSelected,
        inMutuallyExclusiveGroup: true,
        child: Material(
          color: isSelected
              ? OnboardingColors.selectedCardBg
              : OnboardingColors.paperWhite,
          // The hairline is painted on the shape (no layout space), as on the
          // form-flow kit card — so selecting never shifts the content.
          shape: RoundedRectangleBorder(
            borderRadius: radius,
            side: BorderSide(
              color: isSelected
                  ? OnboardingColors.safetyYellow
                  : FormFlowColors.cardBorder,
              width: isSelected ? 1.8 : 1.2,
            ),
          ),
          child: InkWell(
            onTap: onTap,
            borderRadius: radius,
            child: Container(
              constraints: const BoxConstraints(
                minHeight: OnboardingLayout.tapTarget,
              ),
              padding: const EdgeInsets.all(_padding),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      OptionIconTile(
                        icon: icon,
                        isSelected: isSelected,
                        variant: OnboardingVariant.formFlow,
                      ),
                      const Spacer(),
                      OptionRadio(
                        isSelected: isSelected,
                        variant: OnboardingVariant.formFlow,
                      ),
                    ],
                  ),
                  const SizedBox(height: _tileToTitleGap),
                  Text(title, style: OnboardingTypography.formCardTitle()),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A yes/no question as a kit card row: the label on the left, a kit switch on
/// the right, the WHOLE row tappable (48px floor).
///
/// Announced as ONE toggle node carrying [label] and its on/off state — the same
/// semantics the previous `BbToggle(semanticLabel: label)` exposed.
class FinishingToggleRow extends StatelessWidget {
  const FinishingToggleRow({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
    this.color = OnboardingColors.paperWhite,
  });

  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  /// Card fill — white on the canvas; `chipBg` when nested inside a white card.
  final Color color;

  @override
  Widget build(BuildContext context) {
    void flip() => onChanged(!value);
    // Drawn as a form-flow option card — its hairline, radius and title — so
    // it reads as the same component as the option cards on the form pages.
    final BorderRadius radius =
        BorderRadius.circular(FormFlowLayout.cardRadius);
    return Semantics(
      container: true,
      button: true,
      toggled: value,
      label: label,
      onTap: flip,
      excludeSemantics: true,
      child: Material(
        color: color,
        shape: RoundedRectangleBorder(
          borderRadius: radius,
          side: const BorderSide(
            color: FormFlowColors.cardBorder,
            width: 1.2,
          ),
        ),
        child: InkWell(
          onTap: flip,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 56),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      label,
                      style: OnboardingTypography.formCardTitle(),
                    ),
                  ),
                  const SizedBox(width: 12),
                  _KitSwitch(value: value),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The painted switch — on mirrors the kit checkbox (navy fill, yellow border,
/// yellow knob); off is the kit's disabled grey with a white knob. Purely
/// visual: the row owns the tap and the semantics.
class _KitSwitch extends StatelessWidget {
  const _KitSwitch({required this.value});

  final bool value;

  static const double _width = 52;
  static const double _height = 30;
  static const double _knob = 22;
  static const Duration _duration = Duration(milliseconds: 160);

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: _duration,
      curve: Curves.easeOut,
      width: _width,
      height: _height,
      padding: const EdgeInsets.symmetric(horizontal: 3),
      decoration: BoxDecoration(
        color: value ? OnboardingColors.shiftBlue : OnboardingColors.disabledBg,
        borderRadius: BorderRadius.circular(_height / 2),
        border: Border.all(
          color: value ? OnboardingColors.safetyYellow : Colors.transparent,
          width: 1.8,
        ),
      ),
      child: AnimatedAlign(
        duration: _duration,
        curve: Curves.easeOut,
        alignment: value ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          width: _knob,
          height: _knob,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: value
                ? OnboardingColors.safetyYellow
                : OnboardingColors.paperWhite,
          ),
        ),
      ),
    );
  }
}

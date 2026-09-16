import 'package:flutter/material.dart';

import '../theme/onboarding_theme.dart';

/// A small, non-interactive fact pill — a skill/machine tag ("Fanuc"), a kit
/// chip, a resume keyword.
///
/// v3 paints it as a neutral white pill behind a hairline, not a coloured
/// wash: a page of these is a LIST, and colouring every entry made the resume
/// read as a warning panel. Colour is reserved for state that means something.
///
/// Static label only — wrap a [BbButton] or [GestureDetector] for anything
/// tappable (those owe the 48px target; a tag does not).
class BbTag extends StatelessWidget {
  const BbTag(this.label, {super.key});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.chip),
        border: Border.all(color: OnboardingColors.borderDefault),
      ),
      child: Text(label, style: OnboardingTypography.chipLabel()),
    );
  }
}

/// A small solid-yellow pill reading **HOT** in the Anek display voice,
/// shift-blue on the yellow (text on yellow is ALWAYS shift blue).
///
/// EARNED, never uniform: shown only on a featured/urgent job card. Static;
/// not a control.
class BbHotTag extends StatelessWidget {
  const BbHotTag({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: const BoxDecoration(
        color: OnboardingColors.safetyYellow,
        borderRadius: BorderRadius.all(Radius.circular(OnboardingRadii.pillSm)),
      ),
      child: Text(
        'HOT',
        style: OnboardingTypography.anek(
          size: 10,
          weight: FontWeight.w800,
          color: OnboardingColors.textOnYellow,
        ),
      ),
    );
  }
}

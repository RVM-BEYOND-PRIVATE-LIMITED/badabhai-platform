import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// The ALL-CAPS micro label over a group of chips or rows — 'OPERATED
/// MACHINES', 'CONTROLLERS KNOWN' (spec §4).
///
/// Uppercases at RENDER rather than asking the caller for a shouting literal,
/// so the source string stays readable and a label sourced from data is never
/// double-cased.
class KitMicroLabel extends StatelessWidget {
  const KitMicroLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(text.toUpperCase(), style: OnboardingTypography.microLabel());
  }
}

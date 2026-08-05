import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// A small, non-interactive saffron pill — `.aw-tag` (ui.css §48). Used for
/// skill/machine tags (e.g. "Fanuc"), kit chips, and resume keywords; haldi
/// warmth that reads as "this worker knows this".
///
/// Static label only — wrap a [BbButton] or [GestureDetector] for anything
/// tappable (those owe the 48px target; a tag does not).
class BbTag extends StatelessWidget {
  const BbTag(this.label, {super.key});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 5),
      decoration: const BoxDecoration(
        color: AppColors.saffron100,
        borderRadius: BorderRadius.all(Radius.circular(AppRadii.pill)),
      ),
      child: Text(
        label,
        style: AppTypography.body(
          size: AppTypography.sizeXs,
          weight: FontWeight.w700,
          color: AppColors.saffron700,
        ),
      ),
    );
  }
}

/// The kit's `BBHotTag` — a small solid-haldi pill reading **HOT** in the Anek
/// display voice, deep-blue on the yellow (text on haldi is ALWAYS deep blue).
///
/// EARNED, never uniform: shown only on a featured/urgent job card (paired with
/// the haldi left rail). Static; not a control.
class BbHotTag extends StatelessWidget {
  const BbHotTag({super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: const BoxDecoration(
        color: AppColors.haldi,
        borderRadius: BorderRadius.all(Radius.circular(AppRadii.xs)),
      ),
      child: Text(
        'HOT',
        style: AppTypography.display(
          size: 10,
          weight: FontWeight.w800,
          color: AppColors.onHaldi,
        ),
      ),
    );
  }
}

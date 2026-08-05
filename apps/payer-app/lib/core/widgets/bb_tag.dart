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

/// The kit's `BBHotTag` — a solid haldi flag with a deep-blue **Anek** label,
/// marking a featured / urgent card (pairs with [BbCard]'s `featured` rail).
/// Earned, never uniform. Defaults to "HOT"; pass [label] for "URGENT", "NEW".
class BbHotTag extends StatelessWidget {
  const BbHotTag({super.key, this.label = 'HOT'});

  final String label;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
      decoration: BoxDecoration(
        color: AppColors.haldi,
        borderRadius: BorderRadius.circular(AppRadii.xs),
      ),
      child: Text(
        label,
        // Text on haldi is ALWAYS deep blue; the flag speaks in Anek (display).
        style: AppTypography.display(
          size: AppTypography.size2xs,
          weight: FontWeight.w800,
          color: AppColors.onHaldi,
        ),
      ),
    );
  }
}

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

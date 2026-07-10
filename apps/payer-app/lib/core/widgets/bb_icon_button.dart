import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';

/// A square, outlined icon button — `.bb-iconbtn--outline`. The back-arrow and
/// bell affordances in screen headers. Always a 48px tap target.
class BbIconButton extends StatelessWidget {
  const BbIconButton({
    super.key,
    required this.icon,
    required this.onPressed,
    this.semanticLabel,
  });

  final IconData icon;
  final VoidCallback? onPressed;
  final String? semanticLabel;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppColors.surfaceCard,
      borderRadius: BorderRadius.circular(AppRadii.md),
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: Container(
          width: AppSpacing.tap,
          height: AppSpacing.tap,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(color: AppColors.borderStrong, width: 1.5),
          ),
          child: Icon(
            icon,
            size: 22,
            color: AppColors.textSecondary,
            semanticLabel: semanticLabel,
          ),
        ),
      ),
    );
  }
}

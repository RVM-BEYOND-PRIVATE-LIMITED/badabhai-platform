import 'package:flutter/material.dart';

import '../theme/app_haptics.dart';
import '../theme/app_spacing.dart';
import 'bb_pressable.dart';
import '../theme/bb_palette.dart';

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
    // #2591 — the shared press (0.97 + light haptic) wraps the existing button.
    return BbPressable.passive(
      enabled: onPressed != null,
      borderRadius: BorderRadius.circular(AppRadii.md),
      child: _button(context),
    );
  }

  Widget _button(BuildContext context) {
    return Material(
      color: context.bb.card,
      borderRadius: BorderRadius.circular(AppRadii.md),
      child: InkWell(
        onTap: onPressed == null
            ? null
            : () {
                AppHaptics.tap();
                onPressed!();
              },
        borderRadius: BorderRadius.circular(AppRadii.md),
        child: Container(
          width: AppSpacing.tap,
          height: AppSpacing.tap,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AppRadii.md),
            border: Border.all(color: context.bb.borderDefault, width: 1.5),
          ),
          child: Icon(
            icon,
            size: 22,
            color: context.bb.textSecondary,
            semanticLabel: semanticLabel,
          ),
        ),
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';

/// The BadaBhai card surface — `.bb-card`. White on cream, soft warm shadow,
/// 18px corners. Variants cover the design system's modifiers used across the
/// payer app:
///
///  - default      — plain white card.
///  - [ink]        — dark warm surface (balance / earn summary blocks).
///  - [festive]    — 3px double-vermilion border (hero stat, revealed profile).
///  - [interactive]— adds a tap ripple + min 48px target for row-style cards.
///
/// Pass [border] to override the outline (e.g. a "Best value" pack), or
/// [gradient] for the saffron Agency Earn surface.
class BbCard extends StatelessWidget {
  const BbCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.s4),
    this.ink = false,
    this.festive = false,
    this.border,
    this.gradient,
    this.onTap,
    this.opacity = 1,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final bool ink;
  final bool festive;
  final BoxBorder? border;
  final Gradient? gradient;
  final VoidCallback? onTap;

  /// Dim a filled / expired row (the design system dims at ~0.6).
  final double opacity;

  @override
  Widget build(BuildContext context) {
    final Color background = ink ? AppColors.surfaceInk : AppColors.surfaceCard;

    final BoxBorder? effectiveBorder = border ??
        (festive
            ? Border.all(color: AppColors.brandBorder, width: 3)
            : null);

    Widget content = Container(
      padding: padding,
      decoration: BoxDecoration(
        color: gradient == null ? background : null,
        gradient: gradient,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: effectiveBorder,
        boxShadow: ink || gradient != null
            ? null
            : <BoxShadow>[
                BoxShadow(
                  color: AppColors.ink900.withValues(alpha: 0.10),
                  blurRadius: 14,
                  offset: const Offset(0, 6),
                ),
              ],
      ),
      child: child,
    );

    if (onTap != null) {
      content = Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(AppRadii.lg),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: AppSpacing.tap),
            child: content,
          ),
        ),
      );
    }

    if (opacity < 1) {
      content = Opacity(opacity: opacity, child: content);
    }
    return content;
  }
}

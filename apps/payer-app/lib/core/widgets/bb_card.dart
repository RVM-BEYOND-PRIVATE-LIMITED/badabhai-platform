import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';

/// The BadaBhai card surface — `.bb-card`. JUL31: white on canvas, **no
/// shadow** — separated by a single 1px hairline, 10px corners. Variants cover
/// the design system's modifiers used across the payer app:
///
///  - default      — plain white card, 1px hairline border.
///  - [ink]        — dark deep-blue surface (balance / earn summary blocks).
///  - [festive]    — 3px double-haldi border (hero stat, revealed profile).
///  - [featured]   — 4px haldi LEFT RAIL (the kit's mark for a HOT / featured
///    card — earned, never uniform).
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
    this.featured = false,
    this.border,
    this.gradient,
    this.onTap,
    this.opacity = 1,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final bool ink;
  final bool festive;

  /// Draws the 4px haldi left rail — the JUL31 mark for a featured / HOT card.
  /// Earned, never uniform: reserve it for the single hero card in a list.
  final bool featured;
  final BoxBorder? border;
  final Gradient? gradient;
  final VoidCallback? onTap;

  /// Dim a filled / expired row (the design system dims at ~0.6).
  final double opacity;

  @override
  Widget build(BuildContext context) {
    final Color background = ink ? AppColors.surfaceInk : AppColors.surfaceCard;

    // JUL31: separation is a 1px hairline, never a shadow. Festive keeps its
    // 3px double-haldi hero border; ink / gradient surfaces carry their own edge.
    final BoxBorder? effectiveBorder = border ??
        (festive
            ? Border.all(color: AppColors.brandBorder, width: 3)
            : (ink || gradient != null
                ? null
                : Border.all(color: AppColors.border)));

    final BorderRadius radius = BorderRadius.circular(AppRadii.lg);

    Widget content;
    if (featured) {
      // The haldi rail is a single-side border, so it can't share the rounded
      // outline directly (Flutter forbids a non-uniform border with a radius).
      // Draw the surface + hairline on an outer layer, clip to the radius, then
      // lay the 4px rail on the padded inner layer — mirroring the kit's card.
      content = DecoratedBox(
        decoration: BoxDecoration(
          color: gradient == null ? background : null,
          gradient: gradient,
          borderRadius: radius,
          border: effectiveBorder,
        ),
        child: ClipRRect(
          borderRadius: radius,
          child: Container(
            padding: padding,
            decoration: const BoxDecoration(
              border: Border(
                left: BorderSide(color: AppColors.haldi, width: AppSpacing.s1),
              ),
            ),
            child: child,
          ),
        ),
      );
    } else {
      content = Container(
        padding: padding,
        // Clip content to the rounded outline so long/overflowing children never
        // paint past the hairline corners.
        clipBehavior: Clip.antiAlias,
        decoration: BoxDecoration(
          color: gradient == null ? background : null,
          gradient: gradient,
          borderRadius: radius,
          border: effectiveBorder,
        ),
        child: child,
      );
    }

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

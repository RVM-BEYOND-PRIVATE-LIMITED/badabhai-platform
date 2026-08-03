import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';

/// A hero content card in the JUL31 "Josh" system — crisp white paper, a single
/// 1px hairline border, a capped corner radius, and **no shadow** (hairlines are
/// the only separation tool). Reserved for the few hero surfaces: the job card,
/// the resume header, the form pop-up.
///
/// The earlier Desi-Pop truck-art frame (double-vermilion outer + dashed-green
/// inner line + drop shadow) is retired here; featured emphasis now rides a haldi
/// left rail on the card that needs it, never a decorative border. The public API
/// ([child], [padding], [radius]) is unchanged — this is a visual re-skin only.
class BbFestiveCard extends StatelessWidget {
  const BbFestiveCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(AppSpacing.s6),
    this.radius = AppRadii.sm,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double radius;

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(radius),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Padding(padding: padding, child: child),
    );
  }
}

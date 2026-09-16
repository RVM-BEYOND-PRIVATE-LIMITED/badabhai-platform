import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';
import 'kit_pill.dart';

/// The white content card every resume / profile section sits in (spec §4):
/// 16 radius, a 1px [OnboardingColors.borderDefault] hairline, 16 padding.
///
/// Elevation 0 — the hairline is the separation, never a shadow.
class KitCard extends StatelessWidget {
  const KitCard({
    super.key,
    this.padding = const EdgeInsets.all(16),
    required this.child,
  });

  final EdgeInsetsGeometry padding;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: OnboardingColors.paperWhite,
        borderRadius: BorderRadius.circular(OnboardingRadii.card),
        border: Border.all(color: OnboardingColors.borderDefault),
      ),
      child: child,
    );
  }
}

/// A [KitCard]'s header row: a tone-coloured glyph, the section title, and an
/// optional real count (spec §4).
///
/// The count pill is HIDDEN when [count] is null or 0 — an empty section is
/// not rendered at all, and a '0' pill would be a placeholder claiming to be
/// data.
class KitCardHeader extends StatelessWidget {
  const KitCardHeader({
    super.key,
    required this.icon,
    required this.title,
    this.iconColor = OnboardingColors.shiftBlue,
    this.count,
  });

  final IconData icon;
  final String title;
  final Color iconColor;
  final int? count;

  @override
  Widget build(BuildContext context) {
    final int? n = count;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: <Widget>[
        Icon(icon, size: 18, color: iconColor),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            title,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: OnboardingTypography.cardTitle(),
          ),
        ),
        if (n != null && n > 0) ...<Widget>[
          const SizedBox(width: 8),
          KitCountPill(count: n),
        ],
      ],
    );
  }
}

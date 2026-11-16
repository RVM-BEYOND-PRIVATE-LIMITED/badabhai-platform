import 'package:flutter/material.dart';

import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';
import '../theme/bb_palette.dart';

/// Semantic tone of a [BbBadge] — the design system's `.bb-badge--*` set.
///
///  - [success] — green: verified, "Active", money/fit-positive states.
///  - [neutral] — quiet sunken pill: skills, "Quota reached", default chips.
///  - [warning] — saffron: "In review", attention-but-fine.
///  - [danger]  — crimson: the "Hot" flag on a minority of candidates.
///  - [brand]   — vermilion: "Boosted", "Best value".
///  - [info]    — turquoise: "In window" attribution state.
enum BbBadgeTone { success, neutral, warning, danger, brand, info }

/// A small status pill — `.bb-badge`. Static label (+ optional leading icon);
/// never a tap target. [solid] flips to a filled, inverse-text variant used for
/// the "Hot" and "Best value" flags.
///
/// Soft, never numeric: fit is shown as "Strong fit" / "Good fit", never a score.
class BbBadge extends StatelessWidget {
  const BbBadge(
    this.label, {
    super.key,
    this.tone = BbBadgeTone.neutral,
    this.icon,
    this.solid = false,
  });

  final String label;
  final BbBadgeTone tone;
  final IconData? icon;
  final bool solid;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final (Color tint, Color fg, Color solidBg) = switch (tone) {
      BbBadgeTone.success => (
          p.successBg,
          p.success,
          p.success,
        ),
      BbBadgeTone.neutral => (
          p.raised,
          p.textSecondary,
          p.iconSecondary,
        ),
      BbBadgeTone.warning => (
          p.warningBg,
          p.isDark ? p.warning : p.onAction,
          p.actionPressed,
        ),
      BbBadgeTone.danger => (
          p.dangerBg,
          p.danger,
          p.danger,
        ),
      BbBadgeTone.brand => (
          p.selectedCardBg,
          p.textBrand,
          p.action,
        ),
      BbBadgeTone.info => (
          p.infoBg,
          p.infoTitle,
          p.info,
        ),
    };

    final Color background = solid ? solidBg : tint;
    final Color foreground = solid ? p.onAction : fg;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s2, vertical: 4),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(AppRadii.pill),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 13, color: foreground),
            const SizedBox(width: 4),
          ],
          // Flexible (loose fit) sizes to content under unbounded width and
          // ellipsizes only when the badge is width-constrained — required for
          // ellipsis to engage inside a mainAxisSize.min Row.
          Flexible(
            child: Text(
              label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.body(
                size: AppTypography.sizeXs,
                weight: FontWeight.w700,
                color: foreground,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

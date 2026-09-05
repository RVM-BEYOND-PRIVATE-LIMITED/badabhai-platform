import 'package:flutter/material.dart';

import '../theme/app_colors.dart';
import '../theme/app_spacing.dart';
import '../theme/app_typography.dart';

/// Kit `rChip` (14) — chips are the ONE radius that exceeds the 12 hard cap
/// (DESIGN_SPEC §4). A gently rounded rect, not a full stadium: matches the kit's
/// `BBFilterChip` + chat option chips exactly. Not in [AppRadii] (which caps at
/// 12), so it lives here as the chip's local corner.
const double _kChipRadius = 14;

/// A selectable chip — the kit's `BBFilterChip`. Used for skills,
/// single-select filters, and the job-feed header filters.
///
/// [selected] is always **haldi fill + deep-blue label** (the kit's selected
/// state). When unselected, the surface depends on [onDark]:
///  - `false` (default, on a light card): white fill + hairline border + ink label.
///  - `true`  (on the blue feed header): translucent-white fill + white label.
///
/// Optional leading [icon] follows the label colour.
class BbChip extends StatelessWidget {
  const BbChip({
    super.key,
    required this.label,
    this.selected = false,
    this.onTap,
    this.icon,
    this.labelWeight,
    this.onDark = false,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;
  final IconData? icon;

  /// Overrides the label weight. Defaults to the chip's usual bold (`w700`); the
  /// profiling chat's answer chips pass a normal weight so they read exactly like
  /// a chat message (same size + weight), per the owner request.
  final FontWeight? labelWeight;

  /// Render for a blue header (the job feed): unselected chips become
  /// translucent white + white text instead of white-card + ink.
  final bool onDark;

  @override
  Widget build(BuildContext context) {
    // Selected is always the haldi pill with a deep-blue label (kit selected).
    final Color background = selected
        ? AppColors.haldi
        : (onDark ? Colors.white.withValues(alpha: 0.14) : AppColors.surfaceCard);
    final Color borderColor = selected
        ? AppColors.haldi
        : (onDark ? Colors.transparent : AppColors.borderStrong);
    final Color foreground = selected
        ? AppColors.onHaldi
        : (onDark ? AppColors.onBlue : AppColors.textPrimary);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(_kChipRadius),
        // A server-supplied label (a certificate suggestion, a role label —
        // anything not authored client-side) can run long. `Row(mainAxisSize:
        // .min)` alone sizes to the label's own single-line intrinsic width
        // with no ceiling, so a long label just ran the chip off the right
        // edge of the screen instead of wrapping.
        //
        // ONLY cap-and-wrap when the incoming constraint is already BOUNDED
        // (a `Wrap` in a form page — the common case, and the one the "text
        // should go to the next line, not overflow" ask is about). Where the
        // parent hands down an UNBOUNDED width — a horizontally-SCROLLING
        // chip row (the job feed's header, `SingleChildScrollView(scrollDirection:
        // horizontal)`) — leave the chip exactly as it always rendered: a
        // scrolling row is deliberately allowed to run wider than the
        // screen, so there is nothing to wrap there, and forcing a
        // screen-width cap onto every chip in it broke that row's own
        // layout instead of fixing anything.
        child: LayoutBuilder(
          builder: (BuildContext context, BoxConstraints incoming) {
            final bool bounded = incoming.maxWidth.isFinite;
            return ConstrainedBox(
              constraints: BoxConstraints(
                minHeight: AppSpacing.tap,
                maxWidth: bounded ? incoming.maxWidth : double.infinity,
              ),
              child: _chipBody(background, borderColor, foreground, wrap: bounded),
            );
          },
        ),
      ),
    );
  }

  /// [wrap] true → the incoming constraint is bounded (a `Wrap` on a form
  /// page): the label may span multiple lines instead of overflowing.
  /// [wrap] false → unbounded (a horizontally-scrolling chip row): render
  /// exactly as this widget always has, single line, no cap.
  Widget _chipBody(
    Color background,
    Color borderColor,
    Color foreground, {
    required bool wrap,
  }) {
    final Widget labelText = Text(
      label,
      softWrap: wrap,
      style: AppTypography.body(
        size: AppTypography.sizeSm,
        weight: labelWeight ?? FontWeight.w700,
        color: foreground,
      ),
    );
    return Container(
      alignment: Alignment.center,
      padding: const EdgeInsets.symmetric(
        horizontal: 15,
        vertical: AppSpacing.s2,
      ),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(_kChipRadius),
        border: Border.all(color: borderColor, width: 1.5),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 18, color: foreground),
            const SizedBox(width: 6),
          ],
          wrap ? Flexible(child: labelText) : labelText,
        ],
      ),
    );
  }
}

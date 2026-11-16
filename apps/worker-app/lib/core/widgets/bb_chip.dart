import 'package:flutter/material.dart';

import '../theme/bb_palette.dart';
import '../theme/onboarding_theme.dart';

/// A selectable chip — skills, single-select filters, chat option chips.
///
/// [selected] is the v3 selected paint: the warm selected-card fill behind a
/// safety-yellow 1.8 border with a navy label, the same grammar
/// as a ticked option card. When unselected, the surface depends on [onDark]:
///  - `false` (default, on a light card): white fill + hairline + ink label.
///  - `true`  (on a navy header): translucent-white fill + white label.
///
/// [suggested] is a THIRD paint, distinct from both — see its own doc.
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
    this.suggested = false,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;
  final IconData? icon;

  /// HIGHLIGHTED BUT UNTICKED (#1499, ruling D2) — a soft
  /// action-tint wash behind a safety-yellow hairline with
  /// a lightbulb glyph, keeping the ordinary ink label.
  ///
  /// The wash is what makes this a THIRD paint. A WHITE fill (what this briefly
  /// became) is byte-identical to an ordinary unselected chip, which leaves the
  /// border colour as the only difference between "we found this on your
  /// résumé" and "nothing here" — and being visibly distinct from BOTH
  /// neighbours is the whole ruling.
  ///
  /// This is a POINTER, not a state: "your résumé mentioned this one". It must
  /// stay visibly distinct from [selected] (a filled wash with a yellow border),
  /// because "a pre-ticked chip puts a capability on a man's profile that he
  /// never claimed" — a worker reads a filled chip as done and submits the
  /// screen without looking. [selected] therefore always WINS the paint: a chip
  /// he has actually chosen never dims back to a hint.
  ///
  /// DEFAULT FALSE, so every existing call site renders exactly as before.
  final bool suggested;

  /// Overrides the label weight. Defaults to the chip's usual w600; the
  /// profiling chat's answer chips pass a normal weight so they read exactly
  /// like a chat message (same size + weight), per the owner request.
  final FontWeight? labelWeight;

  /// Render for a navy header (the job feed): unselected chips become
  /// translucent white + white text instead of white-card + ink.
  final bool onDark;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    // `suggested` only paints when NOT selected — see its own doc.
    final bool hint = suggested && !selected;
    final Color background = selected
        ? p.selectedCardBg
        : hint
        ? p.actionTint
        : (onDark
              ? p.onBrandSurface.withValues(alpha: 0.14)
              : p.card);
    final Color borderColor = selected
        ? p.action
        : hint
        ? p.action
        : (onDark ? Colors.transparent : p.borderDefault);
    final Color foreground = selected
        ? p.textBrand
        : (onDark ? p.onBrandSurface : p.textPrimary);
    final double borderWidth = selected ? 1.8 : 1.2;

    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(OnboardingRadii.chip),
          // A server-supplied label (a certificate suggestion, a role label —
          // anything not authored client-side) can run long. `Row(mainAxisSize:
          // .min)` alone sizes to the label's own single-line intrinsic width
          // with no ceiling, so a long label just ran the chip off the right
          // edge of the screen instead of wrapping.
          //
          // ONLY cap-and-wrap when the incoming constraint is already BOUNDED
          // (a `Wrap` in a form page — the common case). Where the parent hands
          // down an UNBOUNDED width — a horizontally-SCROLLING chip row (the
          // job feed's header) — leave the chip exactly as it always rendered:
          // a scrolling row is deliberately allowed to run wider than the
          // screen, so there is nothing to wrap there.
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints incoming) {
              final bool bounded = incoming.maxWidth.isFinite;
              return ConstrainedBox(
                constraints: BoxConstraints(
                  minHeight: OnboardingLayout.tapTarget,
                  maxWidth: bounded ? incoming.maxWidth : double.infinity,
                ),
                child: _chipBody(
                  p,
                  background,
                  borderColor,
                  foreground,
                  borderWidth,
                  hint: hint,
                  wrap: bounded,
                ),
              );
            },
          ),
        ),
      ),
    );
  }

  /// [wrap] true → the incoming constraint is bounded (a `Wrap` on a form
  /// page): the label may span multiple lines instead of overflowing.
  /// [wrap] false → unbounded (a horizontally-scrolling chip row): render
  /// exactly as this widget always has, single line, no cap.
  Widget _chipBody(
    BbPalette p,
    Color background,
    Color borderColor,
    Color foreground,
    double borderWidth, {
    required bool hint,
    required bool wrap,
  }) {
    final Widget labelText = Text(
      label,
      softWrap: wrap,
      style: OnboardingTypography.inter(
        size: 13,
        weight: labelWeight ?? FontWeight.w600,
        color: foreground,
      ),
    );
    return Container(
      alignment: Alignment.center,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
      decoration: BoxDecoration(
        color: background,
        borderRadius: BorderRadius.circular(OnboardingRadii.chip),
        border: Border.all(color: borderColor, width: borderWidth),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Icon(icon, size: 16, color: foreground),
            const SizedBox(width: 6),
          ] else if (hint) ...<Widget>[
            // A hint says WHY it is highlighted. Without a mark, a yellow
            // outline alone is one glance away from reading as selected.
            Icon(
              Icons.lightbulb_outline,
              size: 14,
              color: p.actionPressed,
            ),
            const SizedBox(width: 6),
          ],
          wrap ? Flexible(child: labelText) : labelText,
        ],
      ),
    );
  }
}

import 'package:flutter/material.dart';

import '../../theme/bb_palette.dart';
import '../../theme/onboarding_theme.dart';

/// A tappable filter / category chip — job filters, feedback categories.
///
/// Selected is the strict v3 selected paint: the brand surface fill behind an
/// action-yellow border with a yellow check,
/// the same grammar as the option checkbox, so "chosen" looks the same
/// everywhere in the app.
///
/// Unlike the read-only [KitInfoChip] this IS a control, so it clears the 48dp
/// worker touch floor and reports `Semantics(button, selected)`.
class KitSelectChip extends StatelessWidget {
  const KitSelectChip({
    super.key,
    required this.label,
    required this.selected,
    this.onTap,
  });

  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
    final Color background = selected ? p.brandSurface : p.card;
    final Color border = selected ? p.action : p.borderDefault;
    final Color foreground = selected ? p.onBrandSurface : p.textPrimary;
    final BorderRadius radius = BorderRadius.circular(OnboardingRadii.chip);

    return Semantics(
      button: true,
      selected: selected,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: radius,
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints incoming) {
              // Bounded (a Wrap) → the label may wrap. Unbounded (a scrolling
              // row) → render single-line, exactly as a chip row expects.
              final bool bounded = incoming.maxWidth.isFinite;
              final Widget text = Text(
                label,
                softWrap: bounded,
                style: OnboardingTypography.inter(
                  size: 13,
                  weight: FontWeight.w600,
                  color: foreground,
                ),
              );
              return ConstrainedBox(
                constraints: BoxConstraints(
                  minHeight: OnboardingLayout.tapTarget,
                  maxWidth: bounded ? incoming.maxWidth : double.infinity,
                ),
                // NO `alignment:` on this Container, and that is the whole
                // reason a chip is chip-shaped. `Container.alignment` wraps the
                // child in an `Align`, and an `Align` with no width factor
                // takes `constraints.biggest` whenever the width is bounded —
                // which inside a `Wrap` is the Wrap's FULL width. Every filter
                // and feedback category then rendered as a full-width centred
                // row, one per line, instead of spec §4's inline chips. The
                // inner `Row(mainAxisSize: min)` already sizes to content and
                // the `minHeight` below still holds the 48dp touch floor, so
                // the label centres in the tile without it.
                child: Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 14,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: background,
                    borderRadius: radius,
                    border: Border.all(
                      color: border,
                      width: selected ? 1.5 : 1.2,
                    ),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: <Widget>[
                      if (bounded) Flexible(child: text) else text,
                      if (selected) ...<Widget>[
                        const SizedBox(width: 6),
                        Icon(
                          Icons.check_rounded,
                          size: 14,
                          color: p.action,
                        ),
                      ],
                    ],
                  ),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}

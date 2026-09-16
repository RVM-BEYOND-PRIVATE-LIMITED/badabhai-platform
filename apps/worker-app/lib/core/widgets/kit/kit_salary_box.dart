import 'package:flutter/material.dart';

import '../../theme/onboarding_theme.dart';

/// The green money box (spec §4): a label on the left, the figure on the right
/// in tabular mono so digits line up and never jitter.
///
/// **It STACKS instead of squeezing.** The label and the figure are MEASURED
/// against the width the box actually gets, at the ambient text scale, and they
/// sit side by side only when both fit whole. Otherwise they go one above the
/// other — the figure is the whole point of the box and must stay whole.
///
/// Measuring is not belt-and-braces. An earlier version stacked below a fixed
/// 300dp (or past a 1.3 text scale) and put the figure in the inflexible slot
/// of a `Row`, which a `RenderFlex` hands an unbounded main axis: between about
/// 300 and 390dp of box width — exactly what the résumé profile card gets on a
/// 412dp phone — a real range such as '₹24,000 – ₹28,000 / month' beside
/// 'Expected Salary' overflowed the box instead of stacking.
class KitSalaryBox extends StatelessWidget {
  const KitSalaryBox({super.key, required this.label, required this.value});

  final String label;

  /// The formatted figure — already humanized by the caller. Never a raw number
  /// and never a placeholder: a card with no salary on the wire hides this box.
  final String value;

  /// Gap between the label and the figure when they share one line.
  static const double _gap = 10;

  @override
  Widget build(BuildContext context) {
    final TextStyle labelStyle = OnboardingTypography.inter(
      size: 12,
      weight: FontWeight.w600,
      color: OnboardingColors.successGreen,
    );
    final TextStyle valueStyle = OnboardingTypography.mono(
      size: 15,
      weight: FontWeight.w700,
      color: OnboardingColors.successGreen,
    );
    final Widget labelText = Text(label, style: labelStyle);
    final Widget valueText = Text(value, style: valueStyle);

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: OnboardingColors.successBg.withValues(alpha: 0.4),
        borderRadius: BorderRadius.circular(OnboardingRadii.row),
        border: Border.all(color: OnboardingColors.successBorder),
      ),
      child: LayoutBuilder(
        builder: (BuildContext context, BoxConstraints constraints) {
          final TextScaler scaler = MediaQuery.textScalerOf(context);
          final TextDirection direction = Directionality.of(context);
          final double needed =
              _lineWidth(label, labelStyle, scaler, direction) +
              _gap +
              _lineWidth(value, valueStyle, scaler, direction);

          if (needed > constraints.maxWidth) {
            // Stacked: both texts keep their own default soft wrap, so even a
            // figure wider than the box breaks across lines rather than
            // spilling out of it.
            // `width: infinity` so the STACKED box is the same full-width
            // block as the side-by-side one. Without it the Column
            // shrink-wrapped and the box stopped short of the card's edge on
            // the Resume tab while the identical box on job detail ran the
            // full width — one component drawn two widths.
            return SizedBox(
              width: double.infinity,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  labelText,
                  const SizedBox(height: 4),
                  valueText,
                ],
              ),
            );
          }
          // Side by side. Both are known to fit on one line at this width, so
          // the inflexible figure cannot overflow and the `Expanded` label
          // pushes it to the right edge (spec §4's `spaceBetween`).
          return Row(
            children: <Widget>[
              Expanded(child: labelText),
              const SizedBox(width: _gap),
              valueText,
            ],
          );
        },
      ),
    );
  }

  /// Width [text] wants on a single unbroken line in [style] at [scaler].
  static double _lineWidth(
    String text,
    TextStyle style,
    TextScaler scaler,
    TextDirection direction,
  ) {
    final TextPainter painter = TextPainter(
      text: TextSpan(text: text, style: style),
      textDirection: direction,
      textScaler: scaler,
      maxLines: 1,
    )..layout();
    final double width = painter.width;
    painter.dispose();
    return width;
  }
}

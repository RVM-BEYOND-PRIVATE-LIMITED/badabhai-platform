import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';

/// Progress as a rail of dots — no numerals, no denominator (owner ruling, #629).
///
/// The rail must be able to GROW: the total is 8 until the occupation pack pins
/// after Q1, then ~13. A fractional bar would visibly REGRESS when the total
/// grows (5/8 → 5/13), which reads as dishonest; a rail that simply gains dots
/// does not. So this renders [total] dots with the first [filled] filled — as
/// the engine's total grows, more empty dots appear and nothing already filled
/// is ever taken away.
class VoiceDotRail extends StatelessWidget {
  const VoiceDotRail({super.key, required this.filled, required this.total})
      : assert(filled >= 0),
        assert(total >= filled);

  /// Questions answered / the current position (1-based current question ⇒ that
  /// many dots lit).
  final int filled;

  /// Total questions known so far. May increase between questions; never render
  /// a numeral for it.
  final int total;

  static const double _dot = 10;

  @override
  Widget build(BuildContext context) {
    return Semantics(
      // A screen-reader label WITHOUT a denominator, matching the visual.
      label: 'Progress',
      child: Wrap(
        spacing: AppSpacing.s2,
        runSpacing: AppSpacing.s2,
        children: <Widget>[
          for (int i = 0; i < total; i++)
            Container(
              width: _dot,
              height: _dot,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: i < filled ? AppColors.blue : AppColors.ink200,
              ),
            ),
        ],
      ),
    );
  }
}

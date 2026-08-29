import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';

/// Progress as a filled bar — deliberately NOT `VoiceDotRail` (voice_form's
/// progress widget), even though the issue calls that widget out as a
/// candidate. `VoiceDotRail`'s whole design point is a total that can GROW
/// mid-session (the voice engine pins the occupation pack after Q1), so it
/// renders one dot per question and never a numeral, because a numeral
/// denominator that jumps mid-flow would read as dishonest.
///
/// The trade form has NO such growth: `GET /profiling/form` returns every
/// section/screen/question in a SINGLE round trip, so [total] is fixed for
/// the whole session before the worker answers anything. A pack this size
/// (18 questions in the shipped CNC-turner pack, and packs are free to be
/// larger) would also render as a dense multi-row wall of two dozen+ dots —
/// noisier than a single bar for a form this size. A bar is the honest,
/// compact choice here for exactly the reason a dot rail was the honest
/// choice there: each fits the shape of the total it is showing.
class TradeFormProgressBar extends StatelessWidget {
  const TradeFormProgressBar({
    super.key,
    required this.answered,
    required this.total,
  }) : assert(answered >= 0),
       assert(total >= 0);

  final int answered;
  final int total;

  static const double _height = 8;

  @override
  Widget build(BuildContext context) {
    final double fraction =
        total <= 0 ? 0 : (answered / total).clamp(0.0, 1.0);
    return Semantics(
      label: 'Progress',
      value: total <= 0 ? null : '$answered / $total',
      child: ClipRRect(
        borderRadius: BorderRadius.circular(_height / 2),
        child: Container(
          height: _height,
          color: AppColors.ink200,
          alignment: Alignment.centerLeft,
          child: FractionallySizedBox(
            widthFactor: fraction,
            child: Container(
              height: _height,
              decoration: const BoxDecoration(
                color: AppColors.blue,
                borderRadius: BorderRadius.all(Radius.circular(_height / 2)),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

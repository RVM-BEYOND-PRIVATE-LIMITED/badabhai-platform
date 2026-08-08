import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../voice/domain/voice_models.dart';

/// Maps a mic amplitude [dbfs] (negative; 0 = full-scale) to a 0..1 meter
/// fraction with [floorDb] as "silent". Monotonic: a quieter input (covering the
/// mic) yields a strictly smaller fraction, so the bars drop.
double levelFraction(double dbfs, {double floorDb = -60}) {
  final double clamped = dbfs.clamp(floorDb, 0);
  return (clamped - floorDb) / (0 - floorDb);
}

/// A live amplitude meter — a row of bars whose heights track the mic's real
/// dBFS (#629). Covering the mic drops the input level, so the bars visibly fall:
/// the worker can SEE the mic is hearing them, which matters because the mic is
/// warm for the whole session.
///
/// dBFS is negative (0 = full-scale, ~ -60 = quiet). It is mapped to a 0..1
/// fraction so a silent room sits near the floor and a spoken answer swings the
/// bars up. Purely a display — no capture, no decisions.
class VoiceLevelMeter extends StatelessWidget {
  const VoiceLevelMeter({
    super.key,
    required this.levels,
    this.bars = 5,
    this.floorDb = -60,
    this.active = true,
  });

  /// The cubit's live amplitude stream (`VoiceFormCubit.micLevels`).
  final Stream<MicLevel> levels;

  final int bars;

  /// dBFS treated as "silent" — the bottom of the meter.
  final double floorDb;

  /// When false (mic not listening) the meter shows its resting floor in a muted
  /// tone rather than reacting.
  final bool active;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<MicLevel>(
      stream: levels,
      builder: (BuildContext context, AsyncSnapshot<MicLevel> snap) {
        final double level = active && snap.hasData
            ? levelFraction(snap.data!.dbfs, floorDb: floorDb)
            : 0.0;
        return SizedBox(
          height: 24,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              for (int i = 0; i < bars; i++) _bar(i, level),
            ],
          ),
        );
      },
    );
  }

  Widget _bar(int i, double level) {
    // Bars near the centre react more, so the meter reads like a level, not a
    // uniform block: bar i lights when the level clears its own threshold.
    final double threshold = (i + 1) / bars;
    final bool lit = level >= threshold * 0.6;
    final double h = 6.0 + (lit ? 14.0 * math.min(1, level / threshold) : 0.0);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 2),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 90),
        width: 5,
        height: h,
        decoration: BoxDecoration(
          color: !active
              ? AppColors.ink200
              : (lit ? AppColors.blue : AppColors.ink200),
          borderRadius: BorderRadius.circular(2),
        ),
      ),
    );
  }
}

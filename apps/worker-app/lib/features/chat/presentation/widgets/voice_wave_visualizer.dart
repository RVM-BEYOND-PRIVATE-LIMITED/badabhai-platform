import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../../../core/theme/app_colors.dart';

/// A compact, Gemini-style voice visualizer: a small cluster of rounded bars that
/// grow and shrink IN REAL TIME with the mic amplitude while the worker speaks.
///
/// Fed a normalized 0..1 [level] (from `speech_to_text`'s `onSoundLevelChange`,
/// smoothed by the composer against an adaptive noise floor). The bars are
/// AMPLITUDE-reactive only — a fixed centre-weighted envelope, no time-based
/// ripple — so they are STABLE (louder voice = taller bars, quiet = short calm
/// bars), never wobbling on their own.
///
/// PERFORMANCE: a [Ticker] eases the drawn level toward the live one at ~60fps
/// and bumps a [ValueNotifier] the painter listens to via `super.repaint`, so ONLY
/// paint() runs each frame — the widget itself never rebuilds — and a
/// [RepaintBoundary] keeps those repaints off the composer around it.
class VoiceWaveVisualizer extends StatefulWidget {
  const VoiceWaveVisualizer({
    super.key,
    required this.level,
    this.barCount = 5,
    this.color,
    this.width = 40,
  });

  /// Normalized live mic amplitude, 0 (silence) .. 1 (loud).
  final ValueListenable<double> level;

  /// Number of bars (spec: 4–5).
  final int barCount;

  /// Bar colour; defaults to the brand blue.
  final Color? color;

  /// Fixed width of the cluster within the input row.
  final double width;

  @override
  State<VoiceWaveVisualizer> createState() => _VoiceWaveVisualizerState();
}

class _VoiceWaveVisualizerState extends State<VoiceWaveVisualizer> {
  /// The eased, drawn level tracking [widget.level] for a smooth response.
  double _cur = 0;

  /// Repaint pulse — bumped each frame so the painter repaints without a rebuild.
  final ValueNotifier<int> _rev = ValueNotifier<int>(0);

  Ticker? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Ticker(_onTick)..start();
  }

  void _onTick(Duration _) {
    final double target = widget.level.value.clamp(0.0, 1.0);
    // Snappy ease so the bars track the voice closely without jitter.
    _cur += (target - _cur) * 0.4;
    _rev.value++;
  }

  @override
  void dispose() {
    _ticker?.dispose();
    _rev.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      child: SizedBox(
        width: widget.width,
        height: double.infinity,
        child: CustomPaint(
          painter: _BarsPainter(
            levelOf: () => _cur,
            barCount: widget.barCount,
            color: widget.color ?? AppColors.blue,
            repaint: _rev,
          ),
        ),
      ),
    );
  }
}

/// Draws [barCount] rounded vertical bars, centre-weighted, mirrored around the
/// mid-line, each scaled by the live [levelOf]. Repaints are driven by the
/// [repaint] Listenable, so it never depends on a widget rebuild.
class _BarsPainter extends CustomPainter {
  _BarsPainter({
    required this.levelOf,
    required this.barCount,
    required this.color,
    required Listenable repaint,
  }) : super(repaint: repaint);

  final double Function() levelOf;
  final int barCount;
  final Color color;

  /// Resting half-height as a fraction of the max — short, calm bars at silence.
  static const double _idle = 0.18;

  @override
  void paint(Canvas canvas, Size size) {
    final int n = barCount;
    if (n <= 0 || size.width <= 0 || size.height <= 0) return;
    final double lvl = levelOf().clamp(0.0, 1.0);
    // n bars + (n-1) equal gaps → 2n-1 slots of width `barW`.
    final double barW = size.width / (n * 2 - 1);
    final double midY = size.height / 2;
    final double maxHalf = size.height / 2;
    final double centre = (n - 1) / 2;
    final Paint paint = Paint()
      ..color = color
      ..strokeCap = StrokeCap.round
      ..strokeWidth = barW;
    double x = barW / 2;
    for (int i = 0; i < n; i++) {
      // Centre bar tallest, tapering to the edges — a stable, natural envelope.
      final double dist = centre == 0 ? 0 : (i - centre).abs() / centre;
      final double envelope = 1 - 0.5 * dist;
      final double h = _idle + lvl * envelope;
      final double half = (h * maxHalf).clamp(barW / 2, maxHalf);
      canvas.drawLine(Offset(x, midY - half), Offset(x, midY + half), paint);
      x += barW * 2;
    }
  }

  @override
  bool shouldRepaint(_BarsPainter old) =>
      old.color != color || old.barCount != barCount;
}

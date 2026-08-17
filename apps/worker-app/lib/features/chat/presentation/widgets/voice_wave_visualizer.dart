import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../../../core/theme/app_colors.dart';

/// A full-width, STATIC voice waveform (the ChatGPT/Gemini recorder look).
///
/// The bars NEVER move left/right — they sit in fixed positions across the whole
/// input area. In silence they are a flat dotted line; when the worker speaks,
/// the bars RISE INTO A WAVE, tallest in the CENTRE and tapering to dots at the
/// edges, scaled by the live mic amplitude. So it "just creates the wave when it
/// hears sound" — no scrolling, no travelling.
///
/// Fed a normalized 0..1 [level] (from `speech_to_text`'s `onSoundLevelChange`,
/// smoothed by the composer against an adaptive noise floor).
///
/// PERFORMANCE: a [Ticker] eases the drawn level toward the live one at ~60fps and
/// bumps a [ValueNotifier] the painter listens to via `super.repaint`, so ONLY
/// paint() runs each frame (no widget rebuild), inside a [RepaintBoundary].
class VoiceWaveVisualizer extends StatefulWidget {
  const VoiceWaveVisualizer({super.key, required this.level, this.color});

  /// Normalized live mic amplitude, 0 (silence) .. 1 (loud).
  final ValueListenable<double> level;

  /// Bar colour; defaults to a muted grey that reads on the light input pill.
  final Color? color;

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
    // Snappy ease so the wave tracks the voice closely without jitter.
    _cur += (target - _cur) * 0.45;
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
      child: CustomPaint(
        size: const Size(double.infinity, double.infinity),
        painter: _WavePainter(
          levelOf: () => _cur,
          color: widget.color ?? AppColors.textSecondary,
          repaint: _rev,
        ),
      ),
    );
  }
}

/// Draws the full-width bar strip: fixed-position thin bars, each a resting DOT
/// that grows with the live [levelOf] weighted by a CENTRE-tallest envelope and a
/// fixed spatial jaggedness (so it reads as a waveform, not a smooth arc). No time
/// term anywhere → the bars only change HEIGHT with the voice, never position.
class _WavePainter extends CustomPainter {
  _WavePainter({
    required this.levelOf,
    required this.color,
    required Listenable repaint,
  }) : super(repaint: repaint);

  final double Function() levelOf;
  final Color color;

  static const double _barW = 2.0;
  static const double _gap = 3.0;

  /// Resting half-height — a small dot when silent.
  static const double _dotHalf = 1.5;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.width <= 0 || size.height <= 0) return;
    final double lvl = levelOf().clamp(0.0, 1.0);
    final int n = ((size.width + _gap) / (_barW + _gap)).floor();
    if (n <= 0) return;
    final double stripW = n * _barW + (n - 1) * _gap;
    double x = (size.width - stripW) / 2 + _barW / 2;
    final double midY = size.height / 2;
    final double maxHalf = size.height / 2;
    final double centre = (n - 1) / 2;
    final Paint paint = Paint()
      ..color = color
      ..strokeCap = StrokeCap.round
      ..strokeWidth = _barW;
    for (int i = 0; i < n; i++) {
      final double dist = centre == 0 ? 0 : (i - centre) / centre; // -1..1
      // Centre-tallest envelope: 1 in the middle → 0 at the edges (a raised
      // cosine, squared for a tighter central hump like the screenshot).
      final double env = math.cos(dist * math.pi / 2).clamp(0.0, 1.0);
      final double weight = env * env * _noise(i);
      final double half = _dotHalf + lvl * weight * (maxHalf - _dotHalf);
      canvas.drawLine(
        Offset(x, midY - half),
        Offset(x, midY + half),
        paint,
      );
      x += _barW + _gap;
    }
  }

  /// Fixed per-bar jaggedness in ~[0.55, 1.0], purely a function of the bar index
  /// (NO time), so the wave looks like real audio yet never wobbles on its own.
  double _noise(int i) => 0.55 + 0.45 * (0.5 + 0.5 * math.sin(i * 1.7));

  @override
  bool shouldRepaint(_WavePainter oldDelegate) => oldDelegate.color != color;
}

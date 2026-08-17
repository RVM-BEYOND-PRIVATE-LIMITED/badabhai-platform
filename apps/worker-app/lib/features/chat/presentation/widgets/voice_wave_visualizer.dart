import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../../../core/theme/app_colors.dart';

/// A full-width, Gemini-style voice waveform.
///
/// The bars sit in FIXED positions across the whole input area — the strip never
/// scrolls and the central peak never travels sideways. In silence it is a flat
/// dotted line; when the worker speaks the bars RISE INTO A WAVE, tallest in the
/// CENTRE, tapering to dots at the edges.
///
/// SMOOTHNESS (the Gemini feel) comes from three things, all continuous so there
/// is never a pop:
///  1. an ATTACK/RELEASE eased level — bars jump up quickly on speech and fall
///     back slowly, like a real audio meter (no jitter on the sparse mic
///     callbacks);
///  2. a gentle, slowly-advancing FLOW so the crest shimmers and breathes
///     instead of every bar moving in lockstep — kept subtle (~20%) so the centre
///     stays put;
///  3. per-frame drawing at ~60fps.
///
/// Fed a normalized 0..1 [level] (from `speech_to_text`'s `onSoundLevelChange`,
/// smoothed by the composer against an adaptive noise floor).
///
/// PERFORMANCE: a [Ticker] advances the eased level + flow phase and bumps a
/// [ValueNotifier] the painter listens to via `super.repaint`, so ONLY paint()
/// runs each frame (no widget rebuild), inside a [RepaintBoundary].
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
  /// The eased, drawn level — attack fast, release slow.
  double _cur = 0;

  /// Slowly-advancing phase driving the gentle crest flow.
  double _phase = 0;

  /// Repaint pulse — bumped each frame so the painter repaints without a rebuild.
  final ValueNotifier<int> _rev = ValueNotifier<int>(0);

  Ticker? _ticker;
  Duration _last = Duration.zero;

  /// Ease-in (attack) and ease-out (release) factors per frame.
  static const double _attack = 0.32;
  static const double _release = 0.12;

  @override
  void initState() {
    super.initState();
    _ticker = Ticker(_onTick)..start();
  }

  void _onTick(Duration elapsed) {
    // Frame delta (seconds), so the flow speed is stable regardless of refresh
    // rate. Clamped so a paused/janky frame cannot jump the phase.
    final double dt =
        ((elapsed - _last).inMicroseconds / 1e6).clamp(0.0, 1 / 30);
    _last = elapsed;

    final double target = widget.level.value.clamp(0.0, 1.0);
    final double k = target > _cur ? _attack : _release;
    _cur += (target - _cur) * k;

    _phase += dt * 5.0; // gentle flow speed (~5 rad/s)
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
          phaseOf: () => _phase,
          color: widget.color ?? AppColors.textSecondary,
          repaint: _rev,
        ),
      ),
    );
  }
}

/// Draws the full-width bar strip: fixed-position thin bars, each a resting DOT
/// that grows with the eased [levelOf], weighted by a CENTRE-tallest envelope and
/// a subtle time [phaseOf] flow. Positions never change — only heights — so the
/// centre peak stays where it is.
class _WavePainter extends CustomPainter {
  _WavePainter({
    required this.levelOf,
    required this.phaseOf,
    required this.color,
    required Listenable repaint,
  }) : super(repaint: repaint);

  final double Function() levelOf;
  final double Function() phaseOf;
  final Color color;

  static const double _barW = 2.0;
  static const double _gap = 3.0;

  /// Resting half-height — a small dot when silent.
  static const double _dotHalf = 1.5;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.width <= 0 || size.height <= 0) return;
    final double lvl = levelOf().clamp(0.0, 1.0);
    final double phase = phaseOf();
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
      // Centre-tallest envelope (raised cosine, squared for a tighter hump).
      final double env = math.cos(dist * math.pi / 2).clamp(0.0, 1.0);
      final double env2 = env * env;
      // Gentle crest FLOW: two soft sines at different rates for an organic wave.
      // Kept to ~20% of the height and scaled by level, so silence is flat dots
      // and the central peak never drifts.
      final double flow = 0.5 +
          0.5 *
              (0.6 * math.sin(phase - i * 0.45) +
                  0.4 * math.sin(phase * 0.6 + i * 0.22));
      final double amp = env2 * lvl * (0.8 + 0.2 * flow);
      final double half = _dotHalf + amp * (maxHalf - _dotHalf);
      canvas.drawLine(
        Offset(x, midY - half),
        Offset(x, midY + half),
        paint,
      );
      x += _barW + _gap;
    }
  }

  @override
  bool shouldRepaint(_WavePainter oldDelegate) => oldDelegate.color != color;
}

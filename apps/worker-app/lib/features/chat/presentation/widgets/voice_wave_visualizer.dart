import 'dart:math' as math;

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../../../../core/theme/app_colors.dart';

/// A full-width, Gemini-desktop-style voice waveform.
///
/// The bars sit in FIXED positions across the whole input area — the strip never
/// scrolls and the central peak never travels sideways. In silence it is a flat
/// dotted line; when the worker speaks the bars RISE INTO A WAVE, tallest in the
/// CENTRE, tapering to dots at the edges.
///
/// SMOOTHNESS (the Gemini feel): EVERY BAR HAS ITS OWN low-pass ease, so each bar
/// GLIDES toward its target height independently rather than snapping each frame.
/// On top of that the overall level uses an attack/release meter (fast up, slow
/// down) and a gentle, dt-based flow makes the crest breathe. Everything is
/// continuous → no pops, no jitter on the sparse mic callbacks.
///
/// Fed a normalized 0..1 [level] (from `speech_to_text`'s `onSoundLevelChange`,
/// smoothed by the composer against an adaptive noise floor).
///
/// PERFORMANCE: a [Ticker] advances the per-bar state and bumps a [ValueNotifier]
/// the painter listens to via `super.repaint`, so ONLY paint() runs each frame
/// (no widget rebuild), inside a [RepaintBoundary]. Per-bar state is a plain
/// growable list mutated in place (no per-frame allocation).
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
  static const double _barW = 2.0;
  static const double _gap = 3.0;

  /// Per-bar DRAWN amplitude (0..1) — each glides toward its own target.
  List<double> _bars = <double>[];

  /// STATIC centre-weighted envelope per bar (raised-cosine²) — depends only on
  /// the bar count, so it is precomputed on resize instead of recomputing a
  /// `cos()` for every bar every frame. Pure efficiency; the shape is unchanged.
  List<double> _env = <double>[];

  /// Eased overall level — attack fast, release slow (an audio-meter feel).
  double _level = 0;

  /// Slowly-advancing phase driving the gentle crest flow.
  double _phase = 0;

  /// Repaint pulse — bumped each frame so the painter repaints without a rebuild.
  final ValueNotifier<int> _rev = ValueNotifier<int>(0);

  Ticker? _ticker;
  Duration _last = Duration.zero;

  // Smoothing TIME CONSTANTS (seconds), applied dt-based so the feel is identical
  // at 60 / 90 / 120 Hz — a fixed per-frame alpha eased at different real speeds
  // per device and snapped on each sparse RMS step. Attack is short enough to feel
  // live, long enough to GLIDE across the recogniser's coarse ~10-15 Hz RMS
  // updates instead of stepping; release is slow for the smooth fall (water, not
  // a meter). `1 - exp(-dt/tau)` reaches ~90% of a step in ~2.3·tau.
  static const double _lvlAttackTau = 0.06; // ~140ms to 90% — live but glides
  static const double _lvlReleaseTau = 0.32; // ~740ms — long, smooth fall
  static const double _barAttackTau = 0.07;
  static const double _barReleaseTau = 0.34;
  // Continuous traveling ripple: even when the envelope is steady between RMS
  // samples the crest keeps flowing across the strip, so nothing ever looks
  // frozen or stepped. Speed in rad/s.
  static const double _flowSpeed = 4.2;

  @override
  void initState() {
    super.initState();
    _ticker = Ticker(_onTick)..start();
  }

  /// (Re)size the per-bar buffer to the number of bars that fit [width]. Called
  /// from build (idempotent when the width is unchanged).
  void _fit(double width) {
    if (width <= 0) return;
    final int n = ((width + _gap) / (_barW + _gap)).floor().clamp(0, 512);
    if (n == _bars.length) return;
    _bars = List<double>.filled(n, 0);
    // Precompute the static centre-tallest envelope (raised-cosine²) once per
    // size — it never changes frame-to-frame, so the per-bar `cos()` is lifted
    // out of the hot tick loop.
    _env = List<double>.filled(n, 0);
    final double centre = (n - 1) / 2;
    for (int i = 0; i < n; i++) {
      final double dist = centre == 0 ? 0 : (i - centre) / centre; // -1..1
      final double e = math.cos(dist * math.pi / 2).clamp(0.0, 1.0);
      _env[i] = e * e;
    }
  }

  void _onTick(Duration elapsed) {
    final int n = _bars.length;
    if (n == 0) {
      _last = elapsed;
      _rev.value++;
      return;
    }
    // Frame delta (seconds), CAPPED so a dropped/slow frame eases by a bounded
    // step instead of lurching. Drives both the flow and the dt-based smoothing,
    // so the motion is identical across 60 / 90 / 120 Hz.
    final double dt =
        ((elapsed - _last).inMicroseconds / 1e6).clamp(0.0, 1 / 30);
    _last = elapsed;

    // dt-based exponential smoothing toward the live level: k = 1 - e^(-dt/tau).
    // A fixed per-frame alpha (the old code) snapped on each sparse RMS step and
    // ran at a different real speed per refresh rate; this glides at a fixed
    // time constant regardless of frame rate.
    final double target = widget.level.value.clamp(0.0, 1.0);
    final double lvlTau = target > _level ? _lvlAttackTau : _lvlReleaseTau;
    _level += (target - _level) * (1 - math.exp(-dt / lvlTau));

    _phase += dt * _flowSpeed;

    for (int i = 0; i < n; i++) {
      // Continuous traveling ripple — two sines at different spatial/temporal
      // frequencies give a water-like crest that keeps flowing across the strip
      // even when the envelope holds steady between the recogniser's coarse RMS
      // samples. Normalized 0..1 and level-scaled, so silence stays flat dots.
      final double flow = 0.5 +
          0.5 *
              (0.6 * math.sin(_phase - i * 0.42) +
                  0.4 * math.sin(_phase * 0.63 + i * 0.19));
      final double barTarget = _env[i] * _level * (0.68 + 0.32 * flow);
      // Each bar low-passes toward its OWN target, dt-based — the independent
      // glide that carries the smoothness (no per-frame snap, no jitter).
      final double cur = _bars[i];
      final double barTau = barTarget > cur ? _barAttackTau : _barReleaseTau;
      _bars[i] = cur + (barTarget - cur) * (1 - math.exp(-dt / barTau));
    }
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
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        _fit(constraints.maxWidth);
        return RepaintBoundary(
          child: CustomPaint(
            size: const Size(double.infinity, double.infinity),
            painter: _WavePainter(
              barsOf: () => _bars,
              barW: _barW,
              gap: _gap,
              color: widget.color ?? AppColors.textSecondary,
              repaint: _rev,
            ),
          ),
        );
      },
    );
  }
}

/// Draws the per-bar heights from [barsOf] as fixed-position rounded bars, centred
/// in the width. Only heights change frame-to-frame — positions never move.
class _WavePainter extends CustomPainter {
  _WavePainter({
    required this.barsOf,
    required this.barW,
    required this.gap,
    required this.color,
    required Listenable repaint,
  }) : super(repaint: repaint);

  final List<double> Function() barsOf;
  final double barW;
  final double gap;
  final Color color;

  /// Resting half-height — a small dot when silent.
  static const double _dotHalf = 1.5;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.width <= 0 || size.height <= 0) return;
    final List<double> bars = barsOf();
    final int n = bars.length;
    if (n <= 0) return;
    final double stripW = n * barW + (n - 1) * gap;
    double x = (size.width - stripW) / 2 + barW / 2;
    final double midY = size.height / 2;
    final double maxHalf = size.height / 2;
    final Paint paint = Paint()
      ..color = color
      ..strokeCap = StrokeCap.round
      ..strokeWidth = barW;
    for (int i = 0; i < n; i++) {
      final double amp = bars[i].clamp(0.0, 1.0);
      final double half = _dotHalf + amp * (maxHalf - _dotHalf);
      canvas.drawLine(Offset(x, midY - half), Offset(x, midY + half), paint);
      x += barW + gap;
    }
  }

  @override
  bool shouldRepaint(_WavePainter oldDelegate) =>
      oldDelegate.color != color ||
      oldDelegate.barW != barW ||
      oldDelegate.gap != gap;
}

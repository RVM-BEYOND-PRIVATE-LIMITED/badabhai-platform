/// THE ROLE ILLUSTRATION — the animated header of a job card, keyed by the
/// posting's `role_kind`.
///
/// ONE SOURCE, TWO PLATFORMS. The art is authored once as SVG in
/// `packages/role-art/art/`, and `packages/role-art/scripts/generate.mjs`
/// emits [role_art_data.g.dart] (normalized path commands + the motion of
/// each named part) next to the web's React data. This file only PAINTS that
/// data, so the worker's card and the payer's live preview draw the same
/// picture and move the same parts the same way. Never edit the generated
/// file — edit the SVG and re-run the generator.
///
/// WHY A CustomPainter AND NOT flutter_svg: the generator already resolves
/// the SVG to plain path commands, so painting them needs nothing beyond
/// `dart:ui` — no new package, no asset-bundle entries, no XML parse at
/// runtime. ~20 small paths a frame, built once per kind and cached.
///
/// MOTION. One [AnimationController] per visible banner, looping the role's
/// 2–4 s cycle; the painter repaints from it inside its own
/// [RepaintBoundary], so the rest of the card is never repainted by the art.
/// It holds the REST POSE (every motion's first keyframe) and runs no ticker
/// when the platform asks for reduced motion
/// ([MediaQuery.disableAnimationsOf]), when the caller passes
/// `animate: false`, or when [TickerMode] is off (an off-stage tab or route;
/// the deck's behind-card) — so a card the worker cannot see costs nothing.
library;

import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../theme/app_spacing.dart';

part 'role_art_data.g.dart';

/// The art every card without a known `role_kind` draws.
const String kRoleArtFallback = 'generic';

/// Test seam, in the spirit of Flutter's own `debugPaintSizeEnabled`: when
/// false every banner paints its rest pose and starts no ticker, so a widget
/// test's `pumpAndSettle` is not held open by a looping animation. The test
/// harness (`test/flutter_test_config.dart`) turns it off; tests that exercise
/// the motion turn it back on.
bool debugRoleArtAnimationsEnabled = true;

/// The illustration id for a raw `role_kind` off the wire. TAKES [Object?] ON
/// PURPOSE: missing, null, a non-string, a wrong-case or unknown kind all draw
/// [kRoleArtFallback] — never an error, never a blank header.
String resolveRoleArtKind(Object? roleKind) =>
    roleKind is String && _kRoleArt.containsKey(roleKind)
    ? roleKind
    : kRoleArtFallback;

/// The generated definition for an illustration id from [resolveRoleArtKind].
RoleArtDef roleArtDef(String kind) =>
    _kRoleArt[kind] ?? _kRoleArt[kRoleArtFallback]!;

/// The canvas every illustration is drawn on (width / height = 3).
const double kRoleArtAspectRatio = _kCanvasWidth / _kCanvasHeight;

// ── The generated data's types (mirror packages/role-art/src/types.ts) ──────

enum RoleArtColour { primary, accent, surface }

enum RoleArtMotionProp { rotate, translateX, translateY, scale, opacity }

/// One entry of the shared motion vocabulary: evenly spaced keyframes, each
/// `base + key * amp`, eased per segment with [Curves.easeInOut] — the same
/// cubic-bezier(.42, 0, .58, 1) the web's keyframes use.
class RoleArtMotionSpec {
  const RoleArtMotionSpec({
    required this.prop,
    required this.base,
    required this.keys,
    required this.eased,
  });

  final RoleArtMotionProp prop;
  final double base;
  final List<double> keys;
  final bool eased;

  /// The property's value at cycle position [t] ∈ [0, 1).
  double valueAt(double amp, double t) {
    final int segments = keys.length - 1;
    final double x = t.clamp(0.0, 1.0) * segments;
    final int i = math.min(x.floor(), segments - 1);
    double u = x - i;
    if (eased) u = Curves.easeInOut.transform(u);
    return base + (keys[i] + (keys[i + 1] - keys[i]) * u) * amp;
  }
}

/// One moving part's motion (see `packages/role-art/scripts/generate.mjs`).
class RoleArtMotion {
  const RoleArtMotion({
    required this.type,
    required this.amp,
    required this.ox,
    required this.oy,
    required this.rate,
    required this.phase,
  });

  final String type;
  final double amp;
  final double ox;
  final double oy;

  /// Whole cycles per loop, so the loop is seamless.
  final int rate;
  final double phase;

  RoleArtMotionSpec get spec => _kMotions[type]!;

  /// Cycle position for loop position [loopT] ∈ [0, 1).
  double cycleAt(double loopT) => (loopT * rate + phase) % 1.0;
}

/// One painted shape. [ops] is a flat opcode stream: 0 moveTo(x,y),
/// 1 lineTo(x,y), 2 cubicTo(6), 3 quadraticBezierTo(4),
/// 4 arcToPoint(rx, ry, rotation, largeArc, sweep, x, y), 5 close.
class RoleArtShape {
  const RoleArtShape({
    required this.colour,
    required this.opacity,
    required this.strokeWidth,
    required this.ops,
  });

  final RoleArtColour colour;
  final double opacity;

  /// 0 = filled; > 0 = a round-capped, round-joined stroke.
  final double strokeWidth;
  final List<double> ops;
}

class RoleArtPart {
  const RoleArtPart({
    required this.name,
    required this.motion,
    required this.shapes,
  });

  final String name;
  final RoleArtMotion? motion;
  final List<RoleArtShape> shapes;
}

class RoleArtDef {
  const RoleArtDef({required this.loopSeconds, required this.parts});

  final double loopSeconds;
  final List<RoleArtPart> parts;

  Duration get loop => Duration(milliseconds: (loopSeconds * 1000).round());
}

// ── The widget ──────────────────────────────────────────────────────────────

/// The card header: the illustration for [roleKind] at the canvas's 3:1
/// ratio, full width, with soft corners. Decorative — excluded from
/// semantics; the card's title already names the job.
class RoleArtBanner extends StatefulWidget {
  const RoleArtBanner({
    super.key,
    required this.roleKind,
    this.animate = true,
    this.borderRadius = AppRadii.md,
  });

  /// The posting's raw `role_kind`; anything unknown draws the generic art.
  final String? roleKind;

  /// False paints the rest pose and runs no ticker.
  final bool animate;
  final double borderRadius;

  /// The illustration this banner draws (`generic` for an unknown kind).
  String get kind => resolveRoleArtKind(roleKind);

  @override
  State<RoleArtBanner> createState() => _RoleArtBannerState();
}

class _RoleArtBannerState extends State<RoleArtBanner>
    with SingleTickerProviderStateMixin {
  late RoleArtDef _def = roleArtDef(widget.kind);
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: _def.loop,
  );

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _sync();
  }

  @override
  void didUpdateWidget(RoleArtBanner oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.kind != widget.kind) {
      _def = roleArtDef(widget.kind);
      _controller.duration = _def.loop;
      // A running repeat() keeps its old period; restart it at the new one
      // (a reused list slot can swap roles under a live controller).
      if (_controller.isAnimating) {
        _controller
          ..stop()
          ..repeat();
      }
    }
    _sync();
  }

  bool get _shouldRun =>
      widget.animate &&
      debugRoleArtAnimationsEnabled &&
      !MediaQuery.disableAnimationsOf(context);

  void _sync() {
    if (_shouldRun) {
      if (!_controller.isAnimating) _controller.repeat();
    } else {
      _controller
        ..stop()
        ..value = 0; // the rest pose — every motion's first keyframe
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: RepaintBoundary(
        child: ClipRRect(
          borderRadius: BorderRadius.circular(widget.borderRadius),
          child: AspectRatio(
            aspectRatio: kRoleArtAspectRatio,
            child: CustomPaint(
              key: ValueKey<String>('roleArt:${widget.kind}'),
              painter: RoleArtPainter(def: _def, progress: _controller),
            ),
          ),
        ),
      ),
    );
  }
}

/// Paints one [RoleArtDef] at loop position [progress] (0..1), scaled to fit.
class RoleArtPainter extends CustomPainter {
  RoleArtPainter({required this.def, required this.progress})
    : super(repaint: progress);

  final RoleArtDef def;
  final Animation<double> progress;

  static final Map<RoleArtDef, List<List<Path>>> _pathCache =
      <RoleArtDef, List<List<Path>>>{};

  List<List<Path>> get _paths => _pathCache.putIfAbsent(
    def,
    () => <List<Path>>[
      for (final RoleArtPart part in def.parts)
        <Path>[for (final RoleArtShape s in part.shapes) _buildPath(s.ops)],
    ],
  );

  @override
  void paint(Canvas canvas, Size size) {
    final List<List<Path>> paths = _paths;
    canvas.save();
    canvas.clipRect(Offset.zero & size);
    canvas.scale(size.width / _kCanvasWidth, size.height / _kCanvasHeight);
    for (int p = 0; p < def.parts.length; p++) {
      final RoleArtPart part = def.parts[p];
      final RoleArtMotion? motion = part.motion;
      canvas.save();
      bool layered = false;
      if (motion != null) {
        final double v = motion.spec.valueAt(
          motion.amp,
          motion.cycleAt(progress.value),
        );
        layered = _applyMotion(canvas, motion, v);
      }
      for (int s = 0; s < part.shapes.length; s++) {
        canvas.drawPath(paths[p][s], _paintFor(part.shapes[s]));
      }
      if (layered) canvas.restore();
      canvas.restore();
    }
    canvas.restore();
  }

  /// Applies one part's transform; returns true when it opened a layer.
  static bool _applyMotion(Canvas canvas, RoleArtMotion m, double v) {
    switch (m.spec.prop) {
      case RoleArtMotionProp.rotate:
        canvas
          ..translate(m.ox, m.oy)
          ..rotate(v * math.pi / 180)
          ..translate(-m.ox, -m.oy);
      case RoleArtMotionProp.translateX:
        canvas.translate(v, 0);
      case RoleArtMotionProp.translateY:
        canvas.translate(0, v);
      case RoleArtMotionProp.scale:
        canvas
          ..translate(m.ox, m.oy)
          ..scale(v)
          ..translate(-m.ox, -m.oy);
      case RoleArtMotionProp.opacity:
        // A group opacity, like the web's on the <g>: composited as one.
        canvas.saveLayer(
          const Rect.fromLTWH(0, 0, _kCanvasWidth, _kCanvasHeight),
          Paint()..color = Color.fromRGBO(0, 0, 0, v.clamp(0.0, 1.0)),
        );
        return true;
    }
    return false;
  }

  static Paint _paintFor(RoleArtShape s) {
    final Paint paint = Paint()
      ..isAntiAlias = true
      ..color = Color(_kPalette[s.colour]!).withValues(alpha: s.opacity);
    if (s.strokeWidth > 0) {
      paint
        ..style = PaintingStyle.stroke
        ..strokeWidth = s.strokeWidth
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round;
    }
    return paint;
  }

  static Path _buildPath(List<double> ops) {
    final Path path = Path();
    int i = 0;
    while (i < ops.length) {
      switch (ops[i].toInt()) {
        case 0:
          path.moveTo(ops[i + 1], ops[i + 2]);
          i += 3;
        case 1:
          path.lineTo(ops[i + 1], ops[i + 2]);
          i += 3;
        case 2:
          path.cubicTo(
            ops[i + 1],
            ops[i + 2],
            ops[i + 3],
            ops[i + 4],
            ops[i + 5],
            ops[i + 6],
          );
          i += 7;
        case 3:
          path.quadraticBezierTo(
            ops[i + 1],
            ops[i + 2],
            ops[i + 3],
            ops[i + 4],
          );
          i += 5;
        case 4:
          path.arcToPoint(
            Offset(ops[i + 6], ops[i + 7]),
            radius: Radius.elliptical(ops[i + 1], ops[i + 2]),
            rotation: ops[i + 3],
            largeArc: ops[i + 4] == 1,
            clockwise: ops[i + 5] == 1,
          );
          i += 8;
        case 5:
          path.close();
          i += 1;
        default:
          throw StateError('role art: unknown path opcode ${ops[i]}');
      }
    }
    return path;
  }

  @override
  bool shouldRepaint(RoleArtPainter oldDelegate) =>
      oldDelegate.def != def || oldDelegate.progress != progress;
}

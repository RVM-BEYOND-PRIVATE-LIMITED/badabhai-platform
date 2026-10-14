import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/onboarding_theme.dart';

/// #2224 — the label under the last message of a FINISHED profiling chat.
///
/// English, by owner decision: no Hinglish or Devanagari twin for this one.
const String kChatEndOfConversationLabel = 'End of conversation';

/// THE "END OF CONVERSATION" MARKER (#2224).
///
/// A finished interview used to just stop: the closing bubble looked like any
/// other turn, so a reopened thread read as one still waiting for an answer.
/// This says where the conversation ended, the way Claude Code marks the end of
/// a session — a soft wavy line either side of a short centred label.
///
///   ∿∿∿∿∿∿∿∿  End of conversation  ∿∿∿∿∿∿∿∿
///
/// NOT AN ACTION, so it is grey and never yellow: nothing here is tappable and
/// there is no speaker button. The line is [OnboardingColors.ink500] at 40%
/// alpha and the label the same ink at 80% — the step-down opacity rule.
///
/// LAYOUT SAFETY: the label takes its intrinsic width on one line and the two
/// lines take what is left, so at 320×568 with text scale 2.0 the squiggles
/// shrink (to nothing, if that is what it takes) and the label never wraps or
/// clips. It is also why the lines are `Flexible`, not `Expanded`.
///
/// STATIC. "Jiggly" is the shape of the line, not an animation.
class ChatEndDivider extends StatelessWidget {
  const ChatEndDivider({super.key});

  /// Line colour: ink500 at 40% — present, never competing with a bubble.
  static const double _lineAlpha = 0.4;

  /// Label colour: the same ink at 80%, so the words stay readable while the
  /// row as a whole reads as quieter than the transcript.
  static const double _labelAlpha = 0.8;

  @override
  Widget build(BuildContext context) {
    final TextStyle labelStyle = OnboardingTypography.inter(
      size: 12,
      color: OnboardingColors.ink500.withValues(alpha: _labelAlpha),
    );
    return RepaintBoundary(
      // ONE semantics node, and it is the LABEL's own. An outer
      // `Semantics(label:)` around a subtree that already contains that same
      // text gives a screen reader two sources for one row; the painted rules
      // are excluded below instead, so TalkBack announces
      // "End of conversation" exactly once.
      child: MergeSemantics(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: AppSpacing.s4),
          // MEASURED, not flexed. Three `Flexible` children would split the row
          // in thirds and squeeze the label on a narrow screen, and an
          // inflexible label overflows one (at a 2.0 system font the label is
          // wider than a 320px phone). Measuring it means the RULES give way
          // first — to nothing, if that is what it takes — and only a label
          // that cannot fit the whole row at all is scaled down. Either way
          // this row can never overflow, and the label never wraps.
          child: LayoutBuilder(
            builder: (BuildContext context, BoxConstraints box) {
              const double gaps = AppSpacing.s3 * 2;
              final double usable = math.max(0, box.maxWidth - gaps);
              final TextPainter painter = TextPainter(
                text: TextSpan(
                  text: kChatEndOfConversationLabel,
                  style: labelStyle,
                ),
                textDirection: Directionality.of(context),
                textScaler: MediaQuery.textScalerOf(context),
                maxLines: 1,
              )..layout();
              final double labelWidth = math.min(painter.width, usable);
              painter.dispose();
              final double ruleWidth = math.max(0, (usable - labelWidth) / 2);
              return Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: <Widget>[
                  SizedBox(
                    width: ruleWidth,
                    child: const _WavyRule(fadeTowards: _FadeEnd.left),
                  ),
                  const SizedBox(width: AppSpacing.s3),
                  SizedBox(
                    width: labelWidth,
                    child: FittedBox(
                      // scaleDown only: at any ordinary size this leaves the
                      // label at its natural 12sp.
                      fit: BoxFit.scaleDown,
                      child: Text(
                        kChatEndOfConversationLabel,
                        maxLines: 1,
                        softWrap: false,
                        textAlign: TextAlign.center,
                        style: labelStyle,
                      ),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.s3),
                  SizedBox(
                    width: ruleWidth,
                    child: const _WavyRule(fadeTowards: _FadeEnd.right),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

/// Which end of a rule dissolves — the OUTER one, away from the label.
enum _FadeEnd { left, right }

/// One side's squiggle: a gentle sine curve that fades out toward [fadeTowards].
class _WavyRule extends StatelessWidget {
  const _WavyRule({required this.fadeTowards});

  final _FadeEnd fadeTowards;

  /// Peak-to-centre height of the wave. Small on purpose: a rule, not a graph.
  static const double _amplitude = 2.5;

  /// One full period. 9px reads as a squiggle rather than as a zigzag.
  static const double _wavelength = 9;

  @override
  Widget build(BuildContext context) {
    return ExcludeSemantics(
      child: CustomPaint(
        // Tall enough for the stroke plus both peaks, and no taller: the row's
        // height must come from the LABEL, which is what grows with text scale.
        size: const Size.fromHeight(_amplitude * 2 + 2),
        painter: _WavyRulePainter(fadeTowards: fadeTowards),
      ),
    );
  }
}

class _WavyRulePainter extends CustomPainter {
  const _WavyRulePainter({required this.fadeTowards});

  final _FadeEnd fadeTowards;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.width <= 0 || size.height <= 0) return;
    final Color ink = OnboardingColors.ink500.withValues(
      alpha: ChatEndDivider._lineAlpha,
    );
    // The squiggle DISSOLVES at its outer end instead of stopping dead. A
    // gradient shader on the paint, never a BackdropFilter: this sits inside a
    // scrolling list, where a backdrop blur is far too expensive.
    final bool fadeLeft = fadeTowards == _FadeEnd.left;
    final Paint paint = Paint()
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..shader = ui.Gradient.linear(
        Offset(0, size.height / 2),
        Offset(size.width, size.height / 2),
        <Color>[
          fadeLeft ? ink.withValues(alpha: 0) : ink,
          fadeLeft ? ink : ink.withValues(alpha: 0),
        ],
      )
      // A hair of blur so the line reads as soft rather than drawn. Cheap: one
      // small stroke, and it is never animated.
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 0.6);

    final double midY = size.height / 2;
    final Path path = Path()..moveTo(0, midY);
    // 1px steps: smooth enough at any width this row can take, and bounded by
    // the width itself (no unbounded loop on a huge canvas).
    for (double x = 0; x <= size.width; x += 1) {
      final double y =
          midY + math.sin((x / _WavyRule._wavelength) * 2 * math.pi) *
              _WavyRule._amplitude;
      path.lineTo(x, y);
    }
    canvas.drawPath(path, paint);
  }

  @override
  bool shouldRepaint(_WavyRulePainter oldDelegate) =>
      oldDelegate.fadeTowards != fadeTowards;
}

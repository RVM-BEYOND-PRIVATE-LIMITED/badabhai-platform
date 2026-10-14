import 'dart:ui' show PathMetric;

import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../domain/resume_form_progress.dart';

const String kResumeDraftPill = 'FORM ADHOORA HAI';
const String kResumeDraftProgressLabel = 'Form progress';
const String kResumeDraftCta = 'Resume poora karein';

/// "Sirf N sawaal baaki hain." — how many questions of the handed-over form
/// are still unanswered, straight from the server's form.
String resumeFormNote(int left) {
  if (left <= 0) return '';
  return left == 1 ? 'Sirf 1 sawaal baaki hai.' : 'Sirf $left sawaal baaki hain.';
}

/// The unfinished-FORM card (design: Mere resume).
///
/// Shown only when the worker was handed a trade form and left part of it
/// unanswered — see [ResumeFormProgress], which also explains why it no
/// longer reads the profile-strength slots. Every number is the server's: the
/// bar is answered / total questions of `GET /profiling/form`, and the note
/// counts the questions left.
class ResumeDraftCard extends StatelessWidget {
  const ResumeDraftCard({
    super.key,
    required this.progress,
    required this.onContinue,
    this.tradeLabel,
  });

  final ResumeFormProgress progress;
  final VoidCallback onContinue;

  /// The worker's trade, for the heading. Null falls back to "Aapka profile".
  final String? tradeLabel;

  @override
  Widget build(BuildContext context) {
    final String note = resumeFormNote(progress.left);
    final int percent = progress.percent;
    final String? trade = tradeLabel;
    return DottedAmberBorder(
      child: Container(
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: OnboardingColors.selectedCardBg,
          borderRadius: BorderRadius.circular(OnboardingRadii.card),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Container(
                  width: 44,
                  height: 44,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: OnboardingColors.yellowTint20,
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: const Icon(
                    Icons.edit_note_outlined,
                    size: 22,
                    color: OnboardingColors.safetyYellowDark,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 3,
                    ),
                    decoration: BoxDecoration(
                      color: OnboardingColors.yellowTint20,
                      borderRadius: BorderRadius.circular(
                        OnboardingRadii.pillSm,
                      ),
                    ),
                    child: Text(
                      '● $kResumeDraftPill',
                      textAlign: TextAlign.center,
                      style: OnboardingTypography.inter(
                        size: 10,
                        weight: FontWeight.w800,
                        color: OnboardingColors.safetyYellowDark,
                      ),
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Text(
              trade == null || trade.trim().isEmpty ? 'Aapka profile' : trade,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: OnboardingTypography.anek(
                size: 16,
                weight: FontWeight.w800,
                color: OnboardingColors.ink900,
              ),
            ),
            if (progress.total > 0) ...<Widget>[
              const SizedBox(height: 10),
              const Divider(height: 1, color: OnboardingColors.borderSubtle),
              const SizedBox(height: 10),
              Row(
                children: <Widget>[
                  Expanded(
                    child: Text(
                      kResumeDraftProgressLabel,
                      style: OnboardingTypography.inter(
                        size: 12,
                        weight: FontWeight.w600,
                        color: OnboardingColors.ink600,
                      ),
                    ),
                  ),
                  Text(
                    '$percent% complete',
                    style: OnboardingTypography.inter(
                      size: 12,
                      weight: FontWeight.w800,
                      color: OnboardingColors.safetyYellowDark,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: percent / 100,
                  minHeight: 7,
                  backgroundColor: OnboardingColors.borderDefault,
                  valueColor: const AlwaysStoppedAnimation<Color>(
                    OnboardingColors.safetyYellow,
                  ),
                ),
              ),
            ],
            if (note.isNotEmpty) ...<Widget>[
              const SizedBox(height: 10),
              Text(
                note,
                style: OnboardingTypography.inter(
                  size: 12,
                  height: 1.4,
                  color: OnboardingColors.ink600,
                ),
              ),
            ],
            const SizedBox(height: 14),
            ElevatedButton(
              onPressed: onContinue,
              style: ElevatedButton.styleFrom(
                backgroundColor: OnboardingColors.safetyYellow,
                foregroundColor: OnboardingColors.textOnYellow,
                elevation: 0,
                minimumSize: const Size(
                  double.infinity,
                  OnboardingLayout.tapTarget,
                ),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(OnboardingRadii.docked),
                ),
              ),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.center,
                children: <Widget>[
                  Flexible(
                    child: Text(
                      kResumeDraftCta,
                      style: OnboardingTypography.buttonLabel(
                        color: OnboardingColors.textOnYellow,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  const Icon(Icons.arrow_forward_rounded, size: 18),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The design's dashed amber outline.
///
/// Painted rather than borrowed: `BoxDecoration.border` draws solid lines only,
/// and the dash is what separates "unfinished" from every SOLID card on the
/// screen without relying on colour alone.
class DottedAmberBorder extends StatelessWidget {
  const DottedAmberBorder({super.key, required this.child});

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return CustomPaint(
      foregroundPainter: _DashedBorderPainter(
        color: OnboardingColors.safetyYellow,
        radius: OnboardingRadii.card,
      ),
      child: child,
    );
  }
}

class _DashedBorderPainter extends CustomPainter {
  const _DashedBorderPainter({required this.color, required this.radius});

  final Color color;
  final double radius;

  static const double _dash = 6;
  static const double _gap = 4;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5;
    final Path path = Path()
      ..addRRect(
        RRect.fromRectAndRadius(
          Offset.zero & size,
          Radius.circular(radius),
        ),
      );
    for (final PathMetric metric in path.computeMetrics()) {
      double start = 0;
      while (start < metric.length) {
        final double end = (start + _dash).clamp(0.0, metric.length);
        canvas.drawPath(metric.extractPath(start, end), paint);
        start = end + _gap;
      }
    }
  }

  @override
  bool shouldRepaint(_DashedBorderPainter old) =>
      old.color != color || old.radius != radius;
}

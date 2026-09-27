import 'dart:ui' show PathMetric;

import 'package:flutter/material.dart';

import '../../../../core/theme/onboarding_theme.dart';
import '../../../../core/util/missing_field_label.dart';
import '../../../profile_tab/domain/profile_summary.dart';

const String kResumeDraftPill = 'FORM ADHOORA HAI';
const String kResumeDraftProgressLabel = 'Form progress';
const String kResumeDraftCta = 'Resume poora karein';

/// "Sirf <a> aur <b> bharna baaki hai." — built from the server's OWN
/// `missing_fields`, humanised at the display edge.
String resumeDraftNote(List<String> missing) {
  final List<String> labels = missing
      .take(2)
      .map(humanizeMissingField)
      .where((String l) => l.trim().isNotEmpty)
      .toList(growable: false);
  if (labels.isEmpty) return '';
  final String joined = labels.length == 1
      ? labels.single
      : '${labels.first} aur ${labels.last}';
  return 'Sirf $joined bharna baaki hai.';
}

/// The unfinished-profile card (design: Mere resume).
///
/// EVERY NUMBER HERE IS THE SERVER'S. The percentage is
/// `strength_signals / strength_max` and the missing line is `missing_fields`,
/// both from `GET /workers/me/profile-summary` — the same two fields the
/// Profile tab's own strength row already reads. Nothing is estimated on the
/// client, and the card does not render at all unless the server actually
/// reports something missing.
class ResumeDraftCard extends StatelessWidget {
  const ResumeDraftCard({
    super.key,
    required this.summary,
    required this.onContinue,
  });

  final ProfileSummary summary;
  final VoidCallback onContinue;

  /// Null when the server gave no denominator — the bar is then not drawn,
  /// because a progress bar without a total is a picture of a guess.
  double? get _fraction {
    final int? max = summary.strengthMax;
    if (max == null || max <= 0) return null;
    return (summary.strengthSignals / max).clamp(0.0, 1.0);
  }

  int? get _percent {
    final double? f = _fraction;
    return f == null ? null : (f * 100).round();
  }

  @override
  Widget build(BuildContext context) {
    final String note = resumeDraftNote(summary.missingFields);
    final int? percent = _percent;
    final String? trade = summary.tradeLabel;
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
            if (percent != null) ...<Widget>[
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
                  value: _fraction,
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

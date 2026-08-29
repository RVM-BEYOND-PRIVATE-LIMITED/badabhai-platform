import 'package:flutter/material.dart';

import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/missing_field_label.dart';

/// The three qualitative bands the Profile-strength consumer maps the server's
/// signal count onto (issue #1322, §9.1). NEVER shown to the worker as a grade
/// or a number — the band only decides WHICH single nudge (if any) to show.
enum ProfileStrengthBand { weak, fair, strong }

/// The strength denominator to reason about when the wire omits `strength_max`.
///
/// The backend contract fixes `strength_max` at 9 (the nine binary field groups,
/// profile-summary.mapper.ts `STRENGTH_MAX`), but the client parses it defensively
/// and it can be null on an older backend — so the band computation falls back to
/// this rather than fabricating a fraction. It is used ONLY to place the band
/// boundaries; no "N/9" is ever rendered (the raw count can even EXCEED the max,
/// because skills/machines each add +1 per item server-side).
const int kProfileStrengthMaxFallback = 9;

/// Maps a raw signal [signals] count to a [ProfileStrengthBand].
///
/// Boundaries are proportional to [max] (default [kProfileStrengthMaxFallback]),
/// so at the contract max of 9 they land exactly where §9.1 documents them:
///  - Weak   : signals <= round(max/3)      → <= 3 of 9
///  - Fair   : signals <= round(2*max/3)    → 4..6 of 9
///  - Strong : otherwise                    → >= 7 of 9
///
/// A non-positive/absent [max] falls back to the contract value. Pure and
/// side-effect-free so the band rule is unit-testable without a widget.
ProfileStrengthBand profileStrengthBand({required int signals, int? max}) {
  final int m = (max != null && max > 0) ? max : kProfileStrengthMaxFallback;
  final int weakCeil = (m / 3).round();
  final int fairCeil = (2 * m / 3).round();
  if (signals <= weakCeil) return ProfileStrengthBand.weak;
  if (signals <= fairCeil) return ProfileStrengthBand.fair;
  return ProfileStrengthBand.strong;
}

// Worker-facing nudge copy, exported so tests assert the exact honest lines and
// the persona net scans them. Calm, aap-form, no exclamation, no tum-form verbs.
const String kProfileStrengthWeakTitle = 'Profile ko mazboot banayein';
const String kProfileStrengthFairTitle = 'Profile lagbhag poori hai';

/// The single Profile-strength nudge (issue #1322, §9.1/§9.2).
///
/// Presentation ONLY — it reads the server's already-computed strength and
/// ordered `missing_fields` and renders AT MOST ONE humanized prompt:
///  - Weak  → the largest missing weight (`missingFields.first`),
///  - Fair  → the single highest-value item (also `missingFields.first`, which the
///            server orders largest-weight-first),
///  - Strong → nothing (silence — the widget collapses to zero height).
///
/// It NEVER renders the number as a grade or an "N/9" score, carries NO action
/// that could gate anything (the résumé download lives elsewhere and is never
/// conditioned on strength), and never shows a raw slug — every field name goes
/// through [humanizeMissingField] at the edge.
class ProfileStrengthCard extends StatelessWidget {
  const ProfileStrengthCard({
    super.key,
    required this.signals,
    required this.max,
    required this.missingFields,
  });

  /// The server signal COUNT (`ProfileSummary.strengthSignals`). Can exceed [max].
  final int signals;

  /// The server denominator (`ProfileSummary.strengthMax`); null on older backends.
  final int? max;

  /// The still-missing slots, largest-weight first (`ProfileSummary.missingFields`).
  final List<String> missingFields;

  @override
  Widget build(BuildContext context) {
    final ProfileStrengthBand band =
        profileStrengthBand(signals: signals, max: max);

    // Strong → silence; nothing missing → nothing to nudge. Either way, collapse.
    if (band == ProfileStrengthBand.strong || missingFields.isEmpty) {
      return const SizedBox.shrink();
    }

    // The single most valuable slot to add next, humanized (never a raw slug).
    final String label = humanizeMissingField(missingFields.first);
    final String title = band == ProfileStrengthBand.weak
        ? kProfileStrengthWeakTitle
        : kProfileStrengthFairTitle;
    final String body = band == ProfileStrengthBand.weak
        ? 'Sabse zaroori: $label jodein.'
        : 'Ek aur cheez: $label jodein.';

    return Container(
      decoration: BoxDecoration(
        // Soft haldi wash — an inviting nudge, not an alarm. Tokens only.
        color: AppColors.haldiTint,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.tips_and_updates_outlined,
              size: 22, color: AppColors.blue),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title,
                    style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        weight: FontWeight.w700,
                        color: AppColors.textPrimary)),
                const SizedBox(height: AppSpacing.hairline),
                Text(body,
                    style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        color: AppColors.textSecondary)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

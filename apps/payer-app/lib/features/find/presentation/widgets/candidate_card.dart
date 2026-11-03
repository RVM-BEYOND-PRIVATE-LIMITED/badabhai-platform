import 'package:flutter/material.dart';

import '../../../../core/data/candidate_search_models.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/util/months_label.dart';
import '../../../../core/widgets/bb_avatar.dart';
import '../../../../core/widgets/bb_badge.dart';
import '../../../../core/widgets/bb_button.dart';
import '../../../../core/widgets/bb_card.dart';

/// "4 yrs experience" — years on the role the card leads with. A 0 bucket is
/// under six months (months are bucketed DOWN to 6), never "0 yrs".
String candidateExperienceLine(CandidateSearchRow row) =>
    '${_tenure(row.skillMonths, zero: 'Under 6 months')} experience';

/// "Industrial Manufacturing · 4.5 yrs", or "… · years not recorded" when the
/// worker never recorded his industry tenure. Null on a row with no industry.
String? candidateIndustryLine(CandidateSearchRow row) {
  final LabelledId? industry = row.industry;
  if (industry == null) return null;
  final int? months = row.industryMonths;
  final String years = months == null
      ? 'years not recorded'
      : _tenure(months, zero: 'under 6 months');
  return '${industry.label} · $years';
}

String _tenure(int months, {required String zero}) =>
    months > 0 ? monthsLabel(months) : zero;

/// The MASKED all-candidates card (ADR-0040 E2) — the per-job applicant card's
/// family: the sealed "••" avatar, the masked "Worker ••3f9a" handle, closed-
/// vocabulary facts, and the SAME ₹40 unlock / View pair.
///
/// It leads with the ROLE. Then: "Related to `picked role`" when he surfaced
/// through a related role (tier 2); years in the role; the industry with its
/// years (or "not recorded"); the city when he recorded one; the rung he stated
/// for this role; up to four of his other roles. [CandidateSearchRow] has no
/// field for a name, phone, photo, employer, salary or address, so nothing
/// identifying can reach this widget — before or after the unlock (the reveal
/// shows only the relay handle).
class CandidateCard extends StatelessWidget {
  const CandidateCard({
    super.key,
    required this.row,
    required this.unlocked,
    required this.unlocking,
    required this.relatedToLabel,
    required this.onUnlock,
    required this.onView,
  });

  final CandidateSearchRow row;

  /// This payer holds a live grant for him (the card shows "View").
  final bool unlocked;

  /// An unlock is in flight (the ₹40 button shows progress, not a second tap).
  final bool unlocking;

  /// The picked role's label, for the tier-2 badge.
  final String? relatedToLabel;
  final VoidCallback onUnlock;
  final VoidCallback onView;

  /// The most other roles a card names.
  static const int maxOtherRoles = 4;

  @override
  Widget build(BuildContext context) {
    final CandidateTradeLevel? rung = row.leadTradeLevel;
    final List<LabelledId> others =
        row.otherRoles.take(maxOtherRoles).toList(growable: false);
    // Tier 2: plainly a related-role match BEFORE the ₹40 spend.
    final String? related = row.matchTier != 2
        ? null
        : (relatedToLabel == null ? 'Related role' : 'Related to $relatedToLabel');
    final String? industry = candidateIndustryLine(row);

    return BbCard(
      // Same marks as the applicant card: a green outline once unlocked.
      border: unlocked ? Border.all(color: AppColors.success, width: 1.5) : null,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const BbAvatar(
            initials: '••',
            size: 50,
            mode: BbAvatarMode.masked,
            sealed: true,
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  row.role.label,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.heading(
                    size: AppTypography.sizeMd,
                    weight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: AppSpacing.gap2),
                Text(
                  row.maskedLabel,
                  maxLines: 1,
                  style: AppTypography.mono(
                    size: AppTypography.sizeXs,
                    color: AppColors.textMuted,
                  ),
                ),
                if (related != null) ...<Widget>[
                  const SizedBox(height: AppSpacing.gap6),
                  // The same copy and tone the applicant card uses for its
                  // tier-2 rows.
                  BbBadge(
                    related,
                    tone: BbBadgeTone.warning,
                    icon: Icons.hub,
                  ),
                ],
                const SizedBox(height: AppSpacing.gap6),
                _Fact(text: candidateExperienceLine(row), strong: true),
                if (industry != null) _Fact(text: industry),
                if (row.city != null)
                  _Fact(text: row.city!, icon: Icons.location_on),
                if (rung != null || others.isNotEmpty) ...<Widget>[
                  const SizedBox(height: AppSpacing.gap6),
                  Wrap(
                    spacing: AppSpacing.gap6,
                    runSpacing: AppSpacing.gap6,
                    children: <Widget>[
                      // Display only: the rung he stated, printed verbatim. It
                      // never re-sorts or filters anything.
                      if (rung != null)
                        BbBadge(
                          rung.tradeLevelLabel,
                          tone: BbBadgeTone.info,
                          icon: Icons.military_tech,
                        ),
                      for (final LabelledId role in others)
                        BbBadge(role.label, tone: BbBadgeTone.neutral),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
          if (unlocked)
            BbButton(
              label: 'View',
              size: BbButtonSize.md,
              iconLeft: Icons.chat_bubble_outline,
              onPressed: onView,
            )
          else
            BbButton(
              label: '₹40',
              // md (44px) not sm — the paid CTA clears the 48px tap floor
              // (#1082), exactly like the applicant card's.
              size: BbButtonSize.md,
              iconLeft: Icons.lock_open,
              loading: unlocking,
              onPressed: onUnlock,
            ),
        ],
      ),
    );
  }
}

class _Fact extends StatelessWidget {
  const _Fact({required this.text, this.icon, this.strong = false});

  final String text;
  final IconData? icon;
  final bool strong;

  @override
  Widget build(BuildContext context) {
    final TextStyle style = AppTypography.body(
      size: AppTypography.sizeSm,
      weight: strong ? FontWeight.w600 : FontWeight.w400,
      color: AppColors.textSecondary,
      height: 1.35,
    );
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.gap2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (icon != null) ...<Widget>[
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.gap2),
              child: Icon(icon, size: 15, color: AppColors.textMuted),
            ),
            const SizedBox(width: AppSpacing.s1),
          ],
          Flexible(child: Text(text, style: style)),
        ],
      ),
    );
  }
}

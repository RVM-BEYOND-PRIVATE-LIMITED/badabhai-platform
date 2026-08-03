import 'package:flutter/material.dart';

import '../../../../core/data/models.dart';
import '../../../../core/theme/app_colors.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_card.dart';
import '../../../../core/widgets/bb_chip.dart';

/// Matching V1 — the COMPANY posting skill picker + live reach meter.
///
/// The payer picks from a CLOSED demand taxonomy ([skills], the `mskill_*` set
/// from `GET /payer/match/skills`) — never free text, so a posting can only ever
/// reference a known skill id. Each picked skill's related skills come back on
/// the reach preview PRE-TICKED (they widen who sees the job); the payer may
/// untick any of them ([untickedRelatedIds]).
///
/// Everything shown here is PII-free: coarse skill ids/labels and integer reach
/// counts only — never a worker identity.
///
/// This widget is presentational. The owning screen holds the selection state,
/// debounces the reach preview, and enforces the E13 "no posting into a void"
/// gate (empty pick or [ReachPreview.zeroReach] disables Post). The warning copy
/// that explains a blocked Post lives here so it sits with the reach meter.
class MatchSkillPicker extends StatelessWidget {
  const MatchSkillPicker({
    super.key,
    required this.skills,
    required this.pickedIds,
    required this.untickedRelatedIds,
    required this.reach,
    required this.reachLoading,
    required this.maxSkills,
    required this.onToggleSkill,
    required this.onToggleRelated,
  });

  /// The selectable demand skills (closed set).
  final List<MatchSkill> skills;

  /// Currently picked skill ids.
  final Set<String> pickedIds;

  /// Related-skill ids the payer has unticked (excluded from reach).
  final Set<String> untickedRelatedIds;

  /// The latest reach preview, or null before the first one lands.
  final ReachPreview? reach;

  /// True while a debounced reach preview is in flight.
  final bool reachLoading;

  /// Server cap on how many skills one posting may carry.
  final int maxSkills;

  /// Toggle a demand skill's pick state.
  final void Function(String skillId) onToggleSkill;

  /// Toggle a related skill's ticked state (untick removes its reach slice).
  final void Function(String relatedId) onToggleRelated;

  bool get _atCap => pickedIds.length >= maxSkills;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Text(
          'Skills this role needs',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            weight: FontWeight.w700,
          ),
        ),
        const SizedBox(height: AppSpacing.s1),
        Text(
          'Pick up to $maxSkills. No test, no forms — we only show this job to '
          'workers who match.',
          style: AppTypography.body(
            size: AppTypography.sizeSm,
            color: AppColors.textMuted,
            height: 1.4,
          ),
        ),
        const SizedBox(height: AppSpacing.s3),
        Wrap(
          spacing: 7,
          runSpacing: 7,
          children: <Widget>[
            for (final MatchSkill skill in skills)
              _skillChip(skill),
          ],
        ),
        const SizedBox(height: AppSpacing.s4),
        _reachMeter(),
      ],
    );
  }

  Widget _skillChip(MatchSkill skill) {
    final bool picked = pickedIds.contains(skill.skillId);
    // At the server cap, unpicked chips are inert (and dimmed) rather than
    // letting the payer add a skill the contract would reject.
    final bool disabled = !picked && _atCap;
    final Widget chip = BbChip(
      label: skill.label,
      selected: picked,
      icon: picked ? Icons.check : null,
      onTap: disabled ? null : () => onToggleSkill(skill.skillId),
    );
    return disabled ? Opacity(opacity: 0.45, child: chip) : chip;
  }

  /// The live reach meter. Three states:
  ///  - nothing picked → a quiet prompt (Post stays disabled upstream).
  ///  - picked, [ReachPreview.zeroReach] → a saffron warning (E13 gate).
  ///  - picked, reach > 0 → a green count + per-skill breakdown + related chips.
  Widget _reachMeter() {
    if (pickedIds.isEmpty) {
      return _hint(
        icon: Icons.groups_outlined,
        text: 'Pick a skill to see how many workers you can reach.',
      );
    }

    final ReachPreview? r = reach;
    if (r == null) {
      return _hint(
        icon: Icons.groups_outlined,
        text: 'Counting workers…',
        busy: true,
      );
    }

    if (r.zeroReach || r.reachTotal <= 0) {
      return _WarnCard(
        title: 'No workers match yet',
        body: 'Widen the skills (or keep a related one ticked) so this reaches '
            "someone. We won't take a posting no worker can see.",
        busy: reachLoading,
      );
    }

    return BbCard(
      padding: const EdgeInsets.all(AppSpacing.s4),
      border: Border.all(color: AppColors.success, width: 1.5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              const Icon(Icons.groups, size: 24, color: AppColors.green700),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: RichText(
                  text: TextSpan(
                    style: AppTypography.body(
                      size: AppTypography.sizeMd,
                      color: AppColors.textPrimary,
                    ),
                    children: <InlineSpan>[
                      const TextSpan(text: 'Reaches '),
                      TextSpan(
                        text: '${r.reachTotal}',
                        style: AppTypography.mono(
                          size: AppTypography.sizeXl,
                          weight: FontWeight.w700,
                          color: AppColors.green700,
                        ),
                      ),
                      const TextSpan(text: ' workers'),
                    ],
                  ),
                ),
              ),
              if (reachLoading)
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: AppColors.green500,
                  ),
                ),
            ],
          ),
          if (r.reachTier1 > 0) ...<Widget>[
            const SizedBox(height: AppSpacing.s1),
            Text(
              '${r.reachTier1} are a direct match',
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
              ),
            ),
          ],
          for (final ReachSkill s in r.skills) ..._skillBreakdown(s),
        ],
      ),
    );
  }

  List<Widget> _skillBreakdown(ReachSkill s) {
    return <Widget>[
      const SizedBox(height: AppSpacing.s3),
      Row(
        children: <Widget>[
          Expanded(
            child: Text(
              s.label,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                weight: FontWeight.w700,
              ),
            ),
          ),
          Text(
            '+${s.reachCount}',
            style: AppTypography.mono(
              size: AppTypography.sizeSm,
              weight: FontWeight.w700,
              color: AppColors.green700,
            ),
          ),
        ],
      ),
      if (s.related.isNotEmpty) ...<Widget>[
        const SizedBox(height: AppSpacing.s2),
        Wrap(
          spacing: 7,
          runSpacing: 7,
          children: <Widget>[
            for (final RelatedPreview rel in s.related)
              _relatedChip(rel),
          ],
        ),
      ],
    ];
  }

  Widget _relatedChip(RelatedPreview rel) {
    // Drive the ticked state from the local unticked set so the chip flips
    // instantly; the count comes from the server's last preview.
    final bool ticked = !untickedRelatedIds.contains(rel.skillId);
    return BbChip(
      label: '${rel.label} +${rel.reachCount}',
      selected: ticked,
      icon: ticked ? Icons.check : Icons.add,
      onTap: () => onToggleRelated(rel.skillId),
    );
  }

  Widget _hint({
    required IconData icon,
    required String text,
    bool busy = false,
  }) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.s3),
      decoration: BoxDecoration(
        color: AppColors.surfaceSunken,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: Border.all(color: AppColors.borderDefault),
      ),
      child: Row(
        children: <Widget>[
          if (busy)
            const SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: AppColors.textMuted,
              ),
            )
          else
            Icon(icon, size: 20, color: AppColors.textMuted),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: Text(
              text,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The E13 zero-reach warning — a saffron "attention, but fixable" card. Kept
/// private to the picker: it is the only reason Post is blocked once a skill is
/// picked, so its copy lives next to the reach meter.
class _WarnCard extends StatelessWidget {
  const _WarnCard({
    required this.title,
    required this.body,
    required this.busy,
  });

  final String title;
  final String body;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.s3),
      decoration: BoxDecoration(
        color: AppColors.warningTint,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: Border.all(color: AppColors.warning, width: 1.5),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (busy)
            const SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: AppColors.saffron700,
              ),
            )
          else
            const Icon(Icons.error_outline,
                size: 22, color: AppColors.saffron700),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  title,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    weight: FontWeight.w800,
                    color: AppColors.saffron700,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  body,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: AppColors.saffron700,
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

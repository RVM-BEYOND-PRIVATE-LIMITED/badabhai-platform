import 'package:flutter/material.dart';

import '../../../../core/data/models.dart';
import '../../../../core/theme/app_spacing.dart';
import '../../../../core/theme/app_typography.dart';
import '../../../../core/widgets/bb_card.dart';
import '../../../../core/widgets/bb_chip.dart';
import '../../../../core/theme/bb_palette.dart';

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
/// This widget is presentational. The owning screen holds the selection state
/// and debounces the reach preview. Post needs at least one skill picked (so the
/// job can be matched at all); a ZERO reach preview does NOT block posting —
/// reach is dynamic (the backend links workers who join later to an existing
/// open posting), so the reach meter is informational, not a gate.
class MatchSkillPicker extends StatelessWidget {
  const MatchSkillPicker({
    super.key,
    required this.skills,
    required this.pickedIds,
    required this.untickedRelatedIds,
    required this.reach,
    required this.reachLoading,
    required this.reachFailed,
    required this.onRetryReach,
    required this.maxSkills,
    required this.onToggleSkill,
    required this.onToggleRelated,
    this.showReach = true,
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

  /// True when the last reach fetch FAILED (network/5xx). With a pick present
  /// and no preview, this switches the meter from a forever "Counting workers…"
  /// spinner to an honest error + retry, so Post is never silently stuck.
  final bool reachFailed;

  /// Re-run the reach preview for the current pick (the meter's Retry action).
  final VoidCallback onRetryReach;

  /// Server cap on how many skills one posting may carry.
  final int maxSkills;

  /// Toggle a demand skill's pick state.
  final void Function(String skillId) onToggleSkill;

  /// Toggle a related skill's ticked state (untick removes its reach slice).
  final void Function(String relatedId) onToggleRelated;

  /// Whether to render the live reach meter under the chips. The EDIT form passes
  /// false (reach is a create-time concern and the edit screen carries no
  /// debounce), so it keeps the picker without a forever-"Counting workers…"
  /// meter. Defaults true.
  final bool showReach;

  bool get _atCap => pickedIds.length >= maxSkills;

  @override
  Widget build(BuildContext context) {
    final BbPalette p = context.bb;
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
            color: p.textMuted,
            height: 1.4,
          ),
        ),
        const SizedBox(height: AppSpacing.s3),
        Wrap(
          spacing: AppSpacing.chipGap,
          runSpacing: AppSpacing.chipGap,
          children: <Widget>[
            for (final MatchSkill skill in skills)
              _skillChip(skill),
          ],
        ),
        if (showReach) ...<Widget>[
          const SizedBox(height: AppSpacing.s4),
          _reachMeter(context),
        ],
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
      icon: picked ? Icons.check_rounded : null,
      onTap: disabled ? null : () => onToggleSkill(skill.skillId),
    );
    return disabled ? Opacity(opacity: 0.45, child: chip) : chip;
  }

  /// The live reach meter. Three states:
  ///  - nothing picked → a quiet prompt (Post stays disabled upstream).
  ///  - picked, [ReachPreview.zeroReach] → a haldi warning (E13 gate).
  ///  - picked, reach > 0 → a green count + per-skill breakdown + related chips.
  Widget _reachMeter(BuildContext context) {
    if (pickedIds.isEmpty) {
      return _hint(context,
        icon: Icons.groups_rounded,
        text: 'Pick a skill to see how many workers you can reach.',
      );
    }

    final ReachPreview? r = reach;
    if (r == null) {
      // Fetch failed and nothing is in flight → an honest error + Retry, so the
      // payer is not stranded on a spinner with Post disabled.
      if (reachFailed && !reachLoading) {
        return _hint(context,
          icon: Icons.error_rounded,
          text: "Couldn't count workers — check your connection.",
          onRetry: onRetryReach,
        );
      }
      return _hint(context,
        icon: Icons.groups_rounded,
        text: 'Counting workers…',
        busy: true,
      );
    }

    if (r.zeroReach || r.reachTotal <= 0) {
      return _WarnCard(
        title: 'No workers match yet',
        body: "That's OK — you can still post. This job will reach workers as "
            'they join and match these skills. Add more skills to reach people '
            'sooner.',
        busy: reachLoading,
      );
    }

    return BbCard(
      padding: const EdgeInsets.all(AppSpacing.s4),
      border: Border.all(color: context.bb.success, width: 1.5),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: <Widget>[
              Icon(Icons.groups_rounded, size: 24, color: context.bb.success),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: RichText(
                  text: TextSpan(
                    style: AppTypography.body(
                      size: AppTypography.sizeMd,
                      color: context.bb.textPrimary,
                    ),
                    children: <InlineSpan>[
                      const TextSpan(text: 'Reaches '),
                      TextSpan(
                        text: '${r.reachTotal}',
                        style: AppTypography.mono(
                          size: AppTypography.sizeXl,
                          weight: FontWeight.w700,
                          color: context.bb.success,
                        ),
                      ),
                      const TextSpan(text: ' workers'),
                    ],
                  ),
                ),
              ),
              if (reachLoading)
                SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: context.bb.success,
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
                color: context.bb.textMuted,
              ),
            ),
          ],
          for (final ReachSkill s in r.skills) ..._skillBreakdown(context, s),
        ],
      ),
    );
  }

  List<Widget> _skillBreakdown(BuildContext context, ReachSkill s) {
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
              color: context.bb.success,
            ),
          ),
        ],
      ),
      if (s.related.isNotEmpty) ...<Widget>[
        const SizedBox(height: AppSpacing.s2),
        Wrap(
          spacing: AppSpacing.chipGap,
          runSpacing: AppSpacing.chipGap,
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
      icon: ticked ? Icons.check_rounded : Icons.add_rounded,
      onTap: () => onToggleRelated(rel.skillId),
    );
  }

  Widget _hint(BuildContext context, {
    required IconData icon,
    required String text,
    bool busy = false,
    VoidCallback? onRetry,
  }) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.s3),
      decoration: BoxDecoration(
        color: context.bb.raised,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: Border.all(color: context.bb.borderDefault),
      ),
      child: Row(
        children: <Widget>[
          if (busy)
            SizedBox(
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: context.bb.textMuted,
              ),
            )
          else
            Icon(icon, size: 20, color: context.bb.textMuted),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: Text(
              text,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: context.bb.textSecondary,
                height: 1.4,
              ),
            ),
          ),
          if (onRetry != null) ...<Widget>[
            const SizedBox(width: AppSpacing.s2),
            TextButton(
              onPressed: onRetry,
              child: Text(
                'Retry',
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  weight: FontWeight.w700,
                  color: context.bb.textBrand,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// The zero-reach notice — a haldi "heads-up, but fine" card. Zero reach no
/// longer blocks Post (reach is dynamic); this just tells the payer no one
/// matches yet and nudges them to add skills to reach people sooner.
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
    final BbPalette p = context.bb;
    return Container(
      padding: const EdgeInsets.all(AppSpacing.s3),
      decoration: BoxDecoration(
        color: p.warningBg,
        borderRadius: BorderRadius.circular(AppRadii.md),
        border: Border.all(color: p.warning, width: 1.5),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (busy)
            SizedBox(
              width: 22,
              height: 22,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: p.isDark ? p.warning : p.onAction,
              ),
            )
          else
            Icon(Icons.error_rounded,
                size: 22, color: p.isDark ? p.warning : p.onAction),
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
                    color: p.isDark ? p.warning : p.onAction,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  body,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    color: p.isDark ? p.warning : p.onAction,
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

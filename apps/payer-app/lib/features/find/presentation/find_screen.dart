import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/name_mask.dart';
import '../../../core/widgets/bb_avatar.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_field.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import '../../../core/widgets/bb_unlock_dialog.dart';
import 'cubit/find_cubit.dart';
import 'reveal_args.dart';

/// Find — the candidate feed. MOCK mode shows the rich global candidate list
/// (redacted name + "••" avatar). REAL mode shows the FACELESS per-job applicant
/// feed: a masked label derived from the worker UUID, coarse trade/city/exp
/// chips, a red "Hot" flag on a minority, up to two SOFT signal chips (never a
/// number/score), and an Unlock·₹40 button. No demographics in either.
class FindScreen extends StatelessWidget {
  const FindScreen({super.key, required this.onReveal});

  final ValueChanged<RevealArgs> onReveal;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<FindCubit>(
      create: (_) => locator<FindCubit>()..load(),
      child: _FindView(onReveal: onReveal),
    );
  }
}

class _FindView extends StatelessWidget {
  const _FindView({required this.onReveal});

  final ValueChanged<RevealArgs> onReveal;

  // --- MOCK unlock (int id, in-memory spend) --------------------------------
  Future<void> _unlockCandidate(BuildContext context, Candidate candidate) async {
    final CreditsCubit credits = locator<CreditsCubit>();
    final int balance = credits.state ?? 0;
    final bool? confirmed = await showUnlockDialog(
      context,
      shownName: NameMask.redacted(candidate.name),
      creditsAfter: (balance - 1).clamp(0, balance),
    );
    if (confirmed != true || !context.mounted) return;
    await credits.unlock(candidate.id);
    if (!context.mounted) return;
    context.read<FindCubit>().markUnlocked(candidate.id);
    showBbToast(
      context,
      title: 'Unlocked!',
      message: 'Contact details are now visible.',
    );
    onReveal(RevealArgs.mock(candidate.copyWith(unlocked: true)));
  }

  // --- REAL unlock (opaque worker UUID → POST /payer/unlocks) ----------------
  Future<void> _unlockApplicant(BuildContext context, Applicant applicant) async {
    final FindCubit cubit = context.read<FindCubit>();
    final CreditsCubit credits = locator<CreditsCubit>();
    final int balance = credits.state ?? 0;
    final bool? confirmed = await showUnlockDialog(
      context,
      shownName: applicant.maskedLabel,
      creditsAfter: (balance - 1).clamp(0, balance),
    );
    if (confirmed != true || !context.mounted) return;

    final UnlockResult result = await cubit.unlockApplicant(applicant);
    if (!context.mounted) return;

    if (!result.granted) {
      // Neutral deny — no credit / already / capped. Never a fabricated reason.
      showBbToast(
        context,
        title: "Couldn't unlock",
        message: 'This candidate is not available to unlock right now.',
        icon: Icons.info_outline,
      );
      return;
    }
    // Server-truth balance re-read after the grant.
    await credits.load();
    if (!context.mounted) return;
    showBbToast(
      context,
      title: 'Unlocked!',
      message: 'Contact via the in-app relay.',
    );
    onReveal(RevealArgs.real(
      applicant: applicant.copyWith(unlocked: true, unlockId: result.unlockId),
      unlockId: result.unlockId!,
      jobId: cubit.state.selectedJob?.id,
    ));
  }

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<FindCubit, FindState>(
      builder: (BuildContext context, FindState state) {
        if (state.status == FindStatus.loading ||
            state.status == FindStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == FindStatus.error) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load candidates',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<FindCubit>().load(),
            ),
          );
        }
        if (state.status == FindStatus.empty) {
          return const BbStatusView(
            icon: Icons.work_outline,
            title: 'No matched candidates yet',
            subtitle: 'Post a job to see matched candidates here.',
          );
        }

        final bool real = state.isRealFeed;
        final String role = real
            ? (state.selectedJob?.title ?? 'this role')
            : 'CNC Setter';
        final int count = real ? state.applicants.length : state.candidates.length;

        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            Text(
              'CANDIDATES FOR ${role.toUpperCase()}',
              style: AppTypography.eyebrow(color: AppColors.textMuted),
            ),
            const SizedBox(height: 2),
            Text(
              'Browse & unlock',
              style: AppTypography.display(
                size: AppTypography.sizeXl,
                weight: FontWeight.w800,
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            const BbField(
              hint: 'Search trade, skill, location…',
              icon: Icons.search,
            ),
            const SizedBox(height: AppSpacing.s3),
            if (real && state.jobs.length > 1)
              _JobSelector(jobs: state.jobs, selected: state.selectedJob)
            else
              _staticFilters(),
            const SizedBox(height: AppSpacing.s2),
            RichText(
              text: TextSpan(
                style: AppTypography.body(
                  size: AppTypography.sizeSm,
                  color: AppColors.textMuted,
                ),
                children: <InlineSpan>[
                  TextSpan(
                    text: '$count',
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      weight: FontWeight.w700,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const TextSpan(
                    text: ' matched candidates · sorted by relevance, '
                        'never by who paid',
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpacing.s3),
            if (real)
              ...<Widget>[
                if (state.applicants.isEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: AppSpacing.s6),
                    child: Text(
                      'No applicants for this job yet.',
                      textAlign: TextAlign.center,
                      style: AppTypography.body(color: AppColors.textSecondary),
                    ),
                  )
                else
                  for (final Applicant a in state.applicants) ...<Widget>[
                    _ApplicantCard(
                      applicant: a,
                      onUnlock: () => _unlockApplicant(context, a),
                      onView: () => onReveal(RevealArgs.real(
                        applicant: a,
                        unlockId: a.unlockId ?? '',
                        jobId: state.selectedJob?.id,
                      )),
                    ),
                    const SizedBox(height: AppSpacing.s3),
                  ],
              ]
            else
              for (final Candidate c in state.candidates) ...<Widget>[
                _CandidateCard(
                  candidate: c,
                  onUnlock: () => _unlockCandidate(context, c),
                  onView: () =>
                      onReveal(RevealArgs.mock(c.copyWith(unlocked: true))),
                ),
                const SizedBox(height: AppSpacing.s3),
              ],
          ],
        );
      },
    );
  }

  Widget _staticFilters() {
    return SizedBox(
      height: AppSpacing.tap,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: const <Widget>[
          BbChip(
            label: 'Pune · 25 km',
            icon: Icons.location_on_outlined,
            selected: true,
          ),
          SizedBox(width: AppSpacing.s2),
          BbChip(
            label: 'Verified',
            icon: Icons.verified_user_outlined,
            selected: true,
          ),
          SizedBox(width: AppSpacing.s2),
          BbChip(label: '3+ yrs', icon: Icons.military_tech_outlined),
          SizedBox(width: AppSpacing.s2),
          BbChip(label: 'Available now', icon: Icons.schedule),
        ],
      ),
    );
  }
}

/// REAL feed job selector — switches which owned open posting drives the feed.
class _JobSelector extends StatelessWidget {
  const _JobSelector({required this.jobs, required this.selected});

  final List<JobPosting> jobs;
  final JobPosting? selected;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: AppSpacing.tap,
      child: ListView(
        scrollDirection: Axis.horizontal,
        children: <Widget>[
          for (final JobPosting job in jobs) ...<Widget>[
            BbChip(
              label: job.title,
              icon: Icons.work_outline,
              selected: job.id == selected?.id,
              onTap: () => context.read<FindCubit>().selectJob(job),
            ),
            const SizedBox(width: AppSpacing.s2),
          ],
        ],
      ),
    );
  }
}

/// FACELESS real applicant card. No name/phone/skill — a masked UUID label,
/// coarse trade/city/exp facets, an optional "Hot" flag, and up to two SOFT
/// signal chips derived from the ranking reasons (never a number/score).
class _ApplicantCard extends StatelessWidget {
  const _ApplicantCard({
    required this.applicant,
    required this.onUnlock,
    required this.onView,
  });

  final Applicant applicant;
  final VoidCallback onUnlock;
  final VoidCallback onView;

  @override
  Widget build(BuildContext context) {
    final bool masked = !applicant.unlocked;
    final List<String> signals = applicant.softSignals();

    return Container(
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(
          color: masked ? AppColors.borderSubtle : AppColors.success,
          width: masked ? 1 : 1.5,
        ),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: AppColors.ink900.withValues(alpha: 0.06),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
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
                Row(
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        applicant.maskedLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.mono(
                          size: AppTypography.sizeBase,
                          weight: FontWeight.w700,
                        ),
                      ),
                    ),
                    if (applicant.hot) ...<Widget>[
                      const SizedBox(width: 6),
                      const BbBadge(
                        'Hot',
                        tone: BbBadgeTone.danger,
                        icon: Icons.local_fire_department,
                        solid: true,
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  _facets(applicant),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    weight: FontWeight.w600,
                    color: AppColors.textSecondary,
                  ),
                ),
                if (signals.isNotEmpty) ...<Widget>[
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 6,
                    runSpacing: 6,
                    children: <Widget>[
                      for (final String s in signals)
                        BbBadge(s, tone: BbBadgeTone.neutral),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (masked)
                BbButton(
                  label: '₹40',
                  size: BbButtonSize.sm,
                  iconLeft: Icons.lock_open,
                  onPressed: onUnlock,
                )
              else
                BbButton(
                  label: 'View',
                  size: BbButtonSize.sm,
                  iconLeft: Icons.chat_bubble_outline,
                  onPressed: onView,
                ),
            ],
          ),
        ],
      ),
    );
  }

  /// Coarse, non-identifying facets: trade · city · experience band. Any of
  /// them may be null (the signal is unknown) and is simply dropped.
  String _facets(Applicant a) {
    final List<String> parts = <String>[
      if ((a.tradeLabel ?? '').isNotEmpty) a.tradeLabel!,
      if ((a.cityLabel ?? '').isNotEmpty) a.cityLabel!,
      if ((a.experienceBand ?? '').isNotEmpty) a.experienceBand!,
    ];
    return parts.isEmpty ? 'Profile matched' : parts.join(' · ');
  }
}

class _CandidateCard extends StatelessWidget {
  const _CandidateCard({
    required this.candidate,
    required this.onUnlock,
    required this.onView,
  });

  final Candidate candidate;
  final VoidCallback onUnlock;
  final VoidCallback onView;

  @override
  Widget build(BuildContext context) {
    final bool masked = !candidate.unlocked;
    final String shownName = masked
        ? NameMask.redacted(candidate.name)
        : candidate.name;

    return Container(
      padding: const EdgeInsets.all(15),
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.lg),
        border: Border.all(
          color: masked ? AppColors.borderSubtle : AppColors.success,
          width: masked ? 1 : 1.5,
        ),
        boxShadow: <BoxShadow>[
          BoxShadow(
            color: AppColors.ink900.withValues(alpha: 0.06),
            blurRadius: 10,
            offset: const Offset(0, 4),
          ),
        ],
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: <Widget>[
          BbAvatar(
            initials: masked ? '••' : NameMask.initials(candidate.name),
            size: 50,
            mode: masked ? BbAvatarMode.masked : BbAvatarMode.brand,
            sealed: true,
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Row(
                  children: <Widget>[
                    Flexible(
                      child: Text(
                        shownName,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.body(
                          size: AppTypography.sizeBase,
                          weight: FontWeight.w700,
                          color: AppColors.textPrimary,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    const Icon(Icons.verified, size: 15, color: AppColors.success),
                    if (candidate.hot) ...<Widget>[
                      const SizedBox(width: 6),
                      const BbBadge(
                        'Hot',
                        tone: BbBadgeTone.danger,
                        icon: Icons.local_fire_department,
                        solid: true,
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 3),
                Text(
                  '${candidate.trade} · ${candidate.skill}',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: AppTypography.body(
                    size: AppTypography.sizeSm,
                    weight: FontWeight.w600,
                    color: AppColors.textSecondary,
                  ),
                ),
                const SizedBox(height: 4),
                Wrap(
                  spacing: AppSpacing.s3,
                  runSpacing: 2,
                  children: <Widget>[
                    _meta(Icons.military_tech_outlined, candidate.exp),
                    _meta(Icons.location_on_outlined, candidate.loc),
                    _meta(
                      Icons.circle,
                      candidate.avail,
                      color: AppColors.success,
                      bold: true,
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (candidate.fit.label != null) ...<Widget>[
                BbBadge(candidate.fit.label!, tone: BbBadgeTone.success),
                const SizedBox(height: 7),
              ],
              if (masked)
                BbButton(
                  label: '₹40',
                  size: BbButtonSize.sm,
                  iconLeft: Icons.lock_open,
                  onPressed: onUnlock,
                )
              else
                BbButton(
                  label: 'View',
                  size: BbButtonSize.sm,
                  iconLeft: Icons.phone,
                  onPressed: onView,
                ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _meta(IconData icon, String text, {Color? color, bool bold = false}) {
    final Color c = color ?? AppColors.textMuted;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(icon, size: color == AppColors.success ? 9 : 13, color: c),
        const SizedBox(width: 4),
        Text(
          text,
          style: AppTypography.body(
            size: AppTypography.sizeXs,
            weight: bold ? FontWeight.w600 : FontWeight.w400,
            color: c,
          ),
        ),
      ],
    );
  }
}

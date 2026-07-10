import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_progress.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'agency_jobs_screen.dart';
import 'cubit/jobs_cubit.dart';

/// My jobs — role-branched on [AppSession.role].
///
///  - COMPANY: a REAL row (`job.id != null`, from `GET /payer/job-postings`)
///    renders the honest [_RealJobCard] (lifecycle pill + only the LEGAL actions
///    for that state + a plan-&-boost sheet); a MOCK row (`id == null`) keeps the
///    rich [_JobCard] so MOCK stays walkable.
///  - AGENCY: the faceless agency postings (`GET /payer/agency/jobs`) render via
///    [AgencyJobsView] (trade · city/area · pay & experience bands · applicants ·
///    open/closed pill with Pause/Close). The agent routes 403 for a company, so
///    they are only ever mounted here for an agency session.
class JobsScreen extends StatelessWidget {
  const JobsScreen({super.key, required this.onPost});

  final VoidCallback onPost;

  @override
  Widget build(BuildContext context) {
    // The session role is locked at login — branch the whole surface on it so a
    // company never touches the agent-gated routes and vice-versa.
    final bool isAgency = locator<AppSessionCubit>().state?.isAgency ?? false;
    if (isAgency) return AgencyJobsView(onPost: onPost);
    return BlocProvider<JobsCubit>(
      create: (_) => locator<JobsCubit>()..load(),
      child: _JobsView(onPost: onPost),
    );
  }
}

class _JobsView extends StatelessWidget {
  const _JobsView({required this.onPost});

  final VoidCallback onPost;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<JobsCubit, JobsState>(
      builder: (BuildContext context, JobsState state) {
        if (state.status == JobsStatus.loading ||
            state.status == JobsStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == JobsStatus.error) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load jobs',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<JobsCubit>().load(),
            ),
          );
        }

        return ListView(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: <Widget>[
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        'MY JOB POSTINGS',
                        style: AppTypography.eyebrow(color: AppColors.textMuted),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${state.jobs.length} jobs',
                        style: AppTypography.display(
                          size: AppTypography.sizeXl,
                          weight: FontWeight.w800,
                        ),
                      ),
                    ],
                  ),
                ),
                BbButton(
                  label: 'Post',
                  size: BbButtonSize.sm,
                  iconLeft: Icons.add,
                  onPressed: onPost,
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.s3),
            for (final JobPosting job in state.jobs) ...<Widget>[
              // REAL rows carry an id; MOCK rows do not.
              if (job.id == null)
                _JobCard(job: job)
              else
                _RealJobCard(job: job),
              const SizedBox(height: AppSpacing.s3),
            ],
          ],
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// REAL company card — driven by the wire lifecycle string. No fabricated
// quota/counts (the server row has none).
// ---------------------------------------------------------------------------

class _RealJobCard extends StatelessWidget {
  const _RealJobCard({required this.job});

  final JobPosting job;

  String get _wire => job.wireStatus ?? 'draft';

  (String, BbBadgeTone) get _pill => switch (_wire) {
        'open' => ('Open', BbBadgeTone.success),
        'paused' => ('Paused', BbBadgeTone.warning),
        'closed' => ('Closed', BbBadgeTone.neutral),
        _ => ('Draft', BbBadgeTone.neutral),
      };

  /// Runs a one-shot action and surfaces the [JobActionResult] as a toast. The
  /// cubit is read up-front; the context.mounted guard keeps the toast honest
  /// across the await.
  Future<void> _run(
    BuildContext context,
    Future<JobActionResult> Function(JobsCubit) op,
  ) async {
    final JobsCubit cubit = context.read<JobsCubit>();
    final JobActionResult result = await op(cubit);
    if (!context.mounted) return;
    showBbToast(
      context,
      title: result.success ? 'Done' : 'Not now',
      message: result.message,
      icon: result.success ? Icons.check_circle : Icons.info_outline,
    );
  }

  void _openPlanSheet(BuildContext context) {
    final String id = job.id!;
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppColors.surfaceCard,
      showDragHandle: true,
      builder: (BuildContext sheetContext) {
        Widget action(String label, IconData icon, VoidCallback onTap) =>
            Padding(
              padding: const EdgeInsets.only(bottom: AppSpacing.s2),
              child: BbButton(
                label: label,
                iconLeft: icon,
                variant: BbButtonVariant.secondary,
                block: true,
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  onTap();
                },
              ),
            );
        return Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            0,
            AppSpacing.gutter,
            AppSpacing.s5,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Text(
                'Plan & boost',
                style: AppTypography.display(
                  size: AppTypography.sizeMd,
                  weight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: AppSpacing.s3),
              action('Buy plan · Standard', Icons.workspace_premium,
                  () => _run(context, (JobsCubit c) => c.buyPlan(id, 'standard'))),
              action('Buy plan · Pro', Icons.workspace_premium,
                  () => _run(context, (JobsCubit c) => c.buyPlan(id, 'pro'))),
              action('Boost reach', Icons.rocket_launch,
                  () => _run(context, (JobsCubit c) => c.boost(id))),
              // Quota top-up tiers are the pricing `quota_topup` codes
              // (topup_10 / topup_30) — NOT a plan tier like 'standard' (that
              // would be a 400 invalid-tier and the feature would be dead). A
              // 409 (no active plan to top up) is still shown honestly.
              action('Top up quota · +10 views', Icons.add_chart,
                  () => _run(context, (JobsCubit c) => c.topup(id, 'topup_10'))),
              action('Top up quota · +30 views', Icons.add_chart,
                  () => _run(context, (JobsCubit c) => c.topup(id, 'topup_30'))),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final (String label, BbBadgeTone tone) = _pill;
    final bool dim = _wire == 'closed';
    final List<String> meta = <String>[
      if (job.locationLabel != null && job.locationLabel!.isNotEmpty)
        job.locationLabel!,
      if (job.band.isNotEmpty) '${job.band} vacancies',
      if (job.createdAt != null) 'Posted ${_shortDate(job.createdAt!)}',
    ];

    return BbCard(
      opacity: dim ? 0.62 : 1,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: Text(
                  job.title,
                  style: AppTypography.display(
                    size: AppTypography.sizeMd,
                    weight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              BbBadge(label, tone: tone),
            ],
          ),
          if (meta.isNotEmpty) ...<Widget>[
            const SizedBox(height: 2),
            Text(
              meta.join(' · '),
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textMuted,
              ),
            ),
          ],
          const SizedBox(height: AppSpacing.s3),
          ..._actions(context),
        ],
      ),
    );
  }

  List<Widget> _actions(BuildContext context) {
    final String id = job.id!;
    switch (_wire) {
      case 'draft':
        return <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: BbButton(
                  label: 'Publish',
                  size: BbButtonSize.sm,
                  iconLeft: Icons.send,
                  onPressed: () =>
                      _run(context, (JobsCubit c) => c.publish(id)),
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: BbButton(
                  label: 'Close',
                  variant: BbButtonVariant.secondary,
                  size: BbButtonSize.sm,
                  onPressed: () =>
                      _run(context, (JobsCubit c) => c.closePosting(id)),
                ),
              ),
            ],
          ),
        ];
      case 'open':
        return <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: BbButton(
                  label: 'Pause',
                  variant: BbButtonVariant.secondary,
                  size: BbButtonSize.sm,
                  iconLeft: Icons.pause,
                  onPressed: () => _run(context, (JobsCubit c) => c.pause(id)),
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: BbButton(
                  label: 'Close',
                  variant: BbButtonVariant.secondary,
                  size: BbButtonSize.sm,
                  onPressed: () =>
                      _run(context, (JobsCubit c) => c.closePosting(id)),
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s2),
          BbButton(
            label: 'Plan & boost',
            variant: BbButtonVariant.tonal,
            size: BbButtonSize.sm,
            iconLeft: Icons.rocket_launch,
            block: true,
            onPressed: () => _openPlanSheet(context),
          ),
        ];
      case 'paused':
        return <Widget>[
          Row(
            children: <Widget>[
              Expanded(
                child: BbButton(
                  label: 'Resume',
                  size: BbButtonSize.sm,
                  iconLeft: Icons.play_arrow,
                  onPressed: () => _run(context, (JobsCubit c) => c.resume(id)),
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: BbButton(
                  label: 'Plan & boost',
                  variant: BbButtonVariant.tonal,
                  size: BbButtonSize.sm,
                  iconLeft: Icons.rocket_launch,
                  onPressed: () => _openPlanSheet(context),
                ),
              ),
            ],
          ),
        ];
      default: // closed — terminal, no actions.
        return <Widget>[
          Text(
            'This job is closed.',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
        ];
    }
  }

  /// The date portion of an ISO timestamp (no intl dep). Falls back to the raw
  /// string if it is shorter than a date.
  static String _shortDate(String iso) =>
      iso.length >= 10 ? iso.substring(0, 10) : iso;
}

// ---------------------------------------------------------------------------
// MOCK rich card (unchanged) — quota bar + Verified/Boosted badges. Only rendered
// for canned MOCK rows (id == null); never for a REAL server row.
// ---------------------------------------------------------------------------

class _JobCard extends StatelessWidget {
  const _JobCard({required this.job});

  final JobPosting job;

  @override
  Widget build(BuildContext context) {
    final bool dim = job.status == JobStatus.filled;
    final BbBadgeTone statusTone = switch (job.status) {
      JobStatus.live => BbBadgeTone.success,
      JobStatus.filled => BbBadgeTone.neutral,
      JobStatus.review => BbBadgeTone.warning,
    };

    return BbCard(
      opacity: dim ? 0.62 : 1,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: Text(
                  job.title,
                  style: AppTypography.display(
                    size: AppTypography.sizeMd,
                    weight: FontWeight.w700,
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              BbBadge(job.status.label, tone: statusTone),
            ],
          ),
          const SizedBox(height: 2),
          Text(
            '${job.band} · ${job.applicants} applicants · '
            '${job.unlocks} unlocks used',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
          if (job.verified || job.boosted) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            Wrap(
              spacing: 7,
              runSpacing: 7,
              children: <Widget>[
                if (job.verified)
                  const BbBadge(
                    'Verified job',
                    tone: BbBadgeTone.success,
                    icon: Icons.verified_user,
                  ),
                if (job.boosted)
                  const BbBadge(
                    'Boosted',
                    tone: BbBadgeTone.brand,
                    icon: Icons.rocket_launch,
                  ),
              ],
            ),
          ],
          const SizedBox(height: AppSpacing.s3),
          BbProgress(
            value: job.progress,
            label: 'Applicant quota',
            countText: '${job.filled}/${job.quota}',
          ),
          const SizedBox(height: AppSpacing.s3),
          Row(
            children: <Widget>[
              Expanded(
                child: BbButton(
                  label: 'Applicants',
                  variant: BbButtonVariant.secondary,
                  size: BbButtonSize.sm,
                  iconLeft: Icons.groups_outlined,
                  onPressed: () {},
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              Expanded(
                child: BbButton(
                  label: 'Boost',
                  variant: BbButtonVariant.tonal,
                  size: BbButtonSize.sm,
                  iconLeft: Icons.rocket_launch,
                  onPressed: () {},
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

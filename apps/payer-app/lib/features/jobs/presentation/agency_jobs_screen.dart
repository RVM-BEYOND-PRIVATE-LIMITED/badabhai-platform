import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import 'cubit/agency_jobs_cubit.dart';

/// My jobs — AGENCY branch. Lists the agency session's own faceless postings
/// (`GET /payer/agency/jobs`): trade label · title · city/area · pay & experience
/// bands (if set) · applicants-received · a status pill (open/closed). An open
/// row offers Pause/Close; a closed row is terminal. Agent-only — the shell only
/// mounts this for an agency session (the routes 403 for a company).
class AgencyJobsView extends StatelessWidget {
  const AgencyJobsView({super.key, required this.onPost});

  final VoidCallback onPost;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<AgencyJobsCubit>(
      create: (_) => locator<AgencyJobsCubit>()..load(),
      child: _AgencyJobsBody(onPost: onPost),
    );
  }
}

class _AgencyJobsBody extends StatelessWidget {
  const _AgencyJobsBody({required this.onPost});

  final VoidCallback onPost;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<AgencyJobsCubit, AgencyJobsState>(
      builder: (BuildContext context, AgencyJobsState state) {
        if (state.status == AgencyJobsStatus.loading ||
            state.status == AgencyJobsStatus.initial) {
          return const BbStatusView.loading();
        }
        if (state.status == AgencyJobsStatus.error) {
          return BbStatusView(
            icon: Icons.wifi_off,
            title: 'Could not load jobs',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<AgencyJobsCubit>().load(),
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
                        'AGENCY JOB POSTINGS',
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
            for (final AgencyJobView job in state.jobs) ...<Widget>[
              _AgencyJobCard(job: job),
              const SizedBox(height: AppSpacing.s3),
            ],
          ],
        );
      },
    );
  }
}

class _AgencyJobCard extends StatelessWidget {
  const _AgencyJobCard({required this.job});

  final AgencyJobView job;

  (String, BbBadgeTone) get _pill => job.isOpen
      ? ('Open', BbBadgeTone.success)
      : ('Closed', BbBadgeTone.neutral);

  Future<void> _run(
    BuildContext context,
    Future<JobActionResult> Function(AgencyJobsCubit) op,
  ) async {
    final AgencyJobsCubit cubit = context.read<AgencyJobsCubit>();
    final JobActionResult result = await op(cubit);
    if (!context.mounted) return;
    showBbToast(
      context,
      title: result.success ? 'Done' : 'Not now',
      message: result.message,
      icon: result.success ? Icons.check_circle : Icons.info_outline,
    );
  }

  @override
  Widget build(BuildContext context) {
    final (String label, BbBadgeTone tone) = _pill;
    final List<String> meta = <String>[
      job.locationText,
      if (job.payRangeLabel != null) job.payRangeLabel!,
      if (job.experienceLabel != null) job.experienceLabel!,
    ];

    return BbCard(
      opacity: job.isClosed ? 0.62 : 1,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      job.title,
                      style: AppTypography.display(
                        size: AppTypography.sizeMd,
                        weight: FontWeight.w700,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      job.tradeLabel,
                      style: AppTypography.body(
                        size: AppTypography.sizeSm,
                        weight: FontWeight.w600,
                        color: AppColors.brandPress,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: AppSpacing.s2),
              BbBadge(label, tone: tone),
            ],
          ),
          const SizedBox(height: AppSpacing.s2),
          Text(
            meta.join(' · '),
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            '${job.applicantsReceived} applicants received',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          ..._actions(context),
        ],
      ),
    );
  }

  List<Widget> _actions(BuildContext context) {
    if (job.isClosed) {
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
    final String id = job.id;
    return <Widget>[
      Row(
        children: <Widget>[
          Expanded(
            child: BbButton(
              label: 'Pause',
              variant: BbButtonVariant.secondary,
              size: BbButtonSize.sm,
              iconLeft: Icons.pause,
              onPressed: () =>
                  _run(context, (AgencyJobsCubit c) => c.pausePosting(id)),
            ),
          ),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: BbButton(
              label: 'Close',
              variant: BbButtonVariant.secondary,
              size: BbButtonSize.sm,
              onPressed: () =>
                  _run(context, (AgencyJobsCubit c) => c.closePosting(id)),
            ),
          ),
        ],
      ),
    ];
  }
}

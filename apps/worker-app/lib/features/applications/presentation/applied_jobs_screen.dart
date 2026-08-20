import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_app_bar.dart';
import '../../../core/widgets/bb_job_card.dart';
import '../../../core/widgets/bb_scaffold.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
import '../../swipe/domain/job_detail.dart';
import 'cubit/applications_cubit.dart';

/// "Applied jobs" (Profile → Applied jobs). Live-backed by GET /workers/me/applications
/// (worker-scoped, PII-free); lists the worker's APPLY decisions newest-first — from
/// BOTH the legacy alpha feed and the V1 posting feed (the read left-joins `jobs` +
/// `job_postings` server-side). Deliberately no filters, no status timeline, no real
/// job-detail — the backend doesn't back them.
///
/// The READY state carries the kit's **09 Applied-success** feel: a GREEN header
/// with a check stamp + count, then a "what happens next" (AB KYA HOGA) card, then
/// the applications themselves as aligned [BbJobCard]s (each opens the full
/// posting, which shows its already-applied status per WA-2).
class AppliedJobsScreen extends StatelessWidget {
  const AppliedJobsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return BlocProvider<ApplicationsCubit>(
      create: (_) => locator<ApplicationsCubit>()..load(),
      child: const _AppliedJobsView(),
    );
  }
}

class _AppliedJobsView extends StatelessWidget {
  const _AppliedJobsView();

  @override
  Widget build(BuildContext context) {
    return BbScaffold(
      padded: false,
      appBar: const BbAppBar(title: 'Applied jobs'),
      body: BlocBuilder<ApplicationsCubit, ApplicationsState>(
        builder: (BuildContext context, ApplicationsState state) {
          return switch (state.status) {
            ApplicationsStatus.loading => const BbStatusView.loading(),
            ApplicationsStatus.error => BbStatusView(
                icon: failureReason(state.failure).icon,
                title: 'Applied jobs load nahi hui.',
                subtitle: failureReason(state.failure).reason,
                action: FilledButton(
                  onPressed: () => context.read<ApplicationsCubit>().load(),
                  child: const Text('Try again'),
                ),
              ),
            ApplicationsStatus.empty => BbStatusView(
                icon: Icons.work_history_outlined,
                title: 'Abhi tak koi job apply nahi ki',
                action: FilledButton(
                  onPressed: () => context.go(Routes.jobs),
                  child: const Text('Jobs dekhein'),
                ),
              ),
            ApplicationsStatus.ready => _list(context, state.jobs),
          };
        },
      ),
    );
  }

  Widget _list(BuildContext context, List<AppliedJob> jobs) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _successHeader(jobs.length),
        Expanded(
          child: ListView.builder(
            padding: const EdgeInsets.only(bottom: AppSpacing.s4),
            // +1 leading row for the "what happens next" card.
            itemCount: jobs.length + 1,
            itemBuilder: (BuildContext context, int index) {
              if (index == 0) return _whatNextCard();
              return _appliedCard(context, jobs[index - 1]);
            },
          ),
        ),
      ],
    );
  }

  /// The kit-09 GREEN success header: a white check stamp + confirmation line +
  /// count. Every row below is an application the worker already sent, so the
  /// whole screen wears the just-applied confirmation.
  Widget _successHeader(int count) {
    return Container(
      width: double.infinity,
      color: AppColors.success,
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, AppSpacing.s4, AppSpacing.gutter, AppSpacing.s5),
      child: Row(
        children: <Widget>[
          Container(
            width: 44,
            height: 44,
            decoration: const BoxDecoration(
                color: Colors.white, shape: BoxShape.circle),
            child: const Icon(Icons.check, color: AppColors.success, size: 26),
          ),
          const SizedBox(width: AppSpacing.s3),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('Aapki applications',
                    style: AppTypography.display(
                        size: AppTypography.sizeLg,
                        weight: FontWeight.w800,
                        color: Colors.white)),
                const SizedBox(height: 2),
                Text(
                    count == 1 ? '1 job bheji gayi' : '$count jobs bheji gayi',
                    style: AppTypography.body(
                        size: AppTypography.sizeXs,
                        color: AppColors.green100)),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Kit-09 "AB KYA HOGA" — the what-happens-next list, on a hairline paper card.
  /// One shared card above the applications, not a per-row repeat.
  Widget _whatNextCard() {
    return Container(
      margin: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, AppSpacing.s4, AppSpacing.gutter, AppSpacing.s2),
      padding: const EdgeInsets.all(AppSpacing.s4),
      decoration: BoxDecoration(
        color: AppColors.surfaceCard,
        borderRadius: BorderRadius.circular(AppRadii.sm),
        border: Border.all(color: AppColors.borderSubtle),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Text('AB KYA HOGA',
              style: AppTypography.eyebrow(color: AppColors.textMuted)),
          const SizedBox(height: AppSpacing.s3),
          Text(
            '1. Company aapka resume dekhegi\n'
            '2. Pasand aaya toh call ya WhatsApp aayega\n'
            '3. Interview ki date fix hogi',
            style: AppTypography.body(
                color: AppColors.textSecondary, height: 1.7),
          ),
        ],
      ),
    );
  }

  /// One application as an aligned [BbJobCard]. The row already holds the REAL
  /// job facts, so it hands them over as `extra` on tap (there is no worker-facing
  /// job-detail fetch beyond the id, and nothing is synthesised). The row's REAL
  /// `action` rides along so the detail screen shows the applied status instead of
  /// an apply CTA (WA-2). The right-hand meta shows the "Applied · …" label.
  Widget _appliedCard(BuildContext context, AppliedJob job) {
    final String place = (job.area != null && job.area!.isNotEmpty)
        ? '${job.area}, ${job.city}'
        : job.city;
    // "skill · place" as the subtitle line (company is PII, always null). Prefer
    // the human matched-skill LABEL ("MIG Welder") when the feed carries one; else
    // fall back to the legacy `trade_key` — but ONLY when it is a real trade slug,
    // NEVER a raw `mskill_*` id (the #1027 guarantee; under MATCH_V1 trade_key is
    // that id and would read "mskill_mig_welder · Pune"). Else place alone.
    //
    // #1051: the applications API sends `trade_key` but NOT `matched_skill_label`,
    // so a label-only read dropped the trade line for every legacy application
    // (all 17 in production). This restores it without ever surfacing an id.
    final String? label = job.matchedSkillLabel;
    final String? legacyTrade =
        (job.tradeKey.isNotEmpty && !job.tradeKey.startsWith('mskill_'))
            ? job.tradeKey
            : null;
    final String? skill =
        (label != null && label.isNotEmpty) ? label : legacyTrade;
    final String subtitle =
        (skill == null || skill.isEmpty) ? place : '$skill · $place';
    return BbJobCard(
      data: BbJobCardData(
        title: job.title,
        place: subtitle,
        metaRight: appliedRelativeLabel(job.createdAt),
      ),
      onTitleTap: () => context.push(
        '${Routes.jobDetail}/${job.jobId}',
        extra: JobDetail(
          jobId: job.jobId,
          title: job.title,
          city: job.city,
          area: job.area,
          applicationAction: job.action,
        ),
      ),
    );
  }
}

/// "Applied · 2 din pehle" — a coarse Hinglish relative-time label off
/// [createdAt]. [now] is injectable for deterministic tests.
String appliedRelativeLabel(DateTime createdAt, {DateTime? now}) {
  final Duration d = (now ?? DateTime.now()).difference(createdAt);
  final String rel;
  if (d.inMinutes < 1) {
    rel = 'abhi';
  } else if (d.inMinutes < 60) {
    rel = '${d.inMinutes} minute pehle';
  } else if (d.inHours < 24) {
    rel = '${d.inHours} ghante pehle';
  } else {
    rel = '${d.inDays} din pehle';
  }
  return 'Applied · $rel';
}

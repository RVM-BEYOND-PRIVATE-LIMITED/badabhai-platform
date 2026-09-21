import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/trade_key_label.dart';
import '../../../core/widgets/bb_job_card.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/kit/kit_card.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/kit/kit_micro_label.dart';
import '../../../core/widgets/kit/kit_status_banner.dart';
import '../../../core/widgets/onboarding/shift_blue_header.dart';
import '../../../router.dart';
import '../../swipe/domain/job_detail.dart';
import 'cubit/applications_cubit.dart';
import '../../../core/util/push_once.dart';
import '../../../core/widgets/feedback_fab.dart';

/// "Applied jobs" (Profile → Applied jobs). Live-backed by GET /workers/me/applications
/// (worker-scoped, PII-free); lists the worker's APPLY decisions newest-first — from
/// BOTH the legacy alpha feed and the V1 posting feed (the read left-joins `jobs` +
/// `job_postings` server-side). Deliberately no filters, no status timeline, no real
/// job-detail — the backend doesn't back them.
///
/// The READY state opens with the spec §4 navy status banner (the confirmation +
/// the real count), then a "what happens next" (AB KYA HOGA) card, then the
/// applications themselves as [BbJobCard]s (each opens the full posting, which
/// shows its already-applied status per WA-2). The banner is list item 0, so it
/// scrolls away instead of permanently costing a 568dp screen 52dp of height.
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
    return Scaffold(
      backgroundColor: OnboardingColors.canvasBg,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          ShiftBlueHeader(
            title: 'Applied jobs',
            onBack: () => context.pop(),
            // The rows and the navy banner below cap at 600; the header row
            // has to share that edge.
            maxWidth: OnboardingLayout.maxTabContentWidth,
          ),
          Expanded(
            child: BlocBuilder<ApplicationsCubit, ApplicationsState>(
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
          ),
        ],
      ),
    );
  }

  Widget _list(BuildContext context, List<AppliedJob> jobs) {
    final double width = MediaQuery.sizeOf(context).width;
    // The cards carry no side margin of their own, so this is the ONE
    // horizontal inset — and it grows on a tablet so the column stops at 600.
    final EdgeInsets side = KitInsets.list(width, gutter: 14);
    return ListView.builder(
      // No horizontal padding on the scroll view itself: item 0 is the navy
      // banner, which is full-bleed by design.
      padding: EdgeInsets.only(
        bottom:
            14 +
            MediaQuery.paddingOf(context).bottom +
            // The floating Feedback pill's band — empty canvas, not the last
            // card's location line. See [FeedbackFabInset].
            FeedbackFabInset.of(context),
      ),
      // +2 leading rows: the status banner and the "what happens next" card.
      itemCount: jobs.length + 2,
      itemBuilder: (BuildContext context, int index) {
        if (index == 0) return _banner(jobs.length);
        if (index == 1) {
          return Padding(
            padding: side.copyWith(top: 14, bottom: 4),
            child: _whatNextCard(),
          );
        }
        return Padding(
          padding: side,
          child: _appliedCard(context, jobs[index - 2]),
        );
      },
    );
  }

  /// The spec §4 status banner: the confirmation line, the REAL count as a
  /// plain integer pill (R8 — never the word "Verified"), the subline and the
  /// green tick.
  Widget _banner(int count) {
    return KitStatusBanner(
      title: 'Aapki applications',
      pillLabel: '$count',
      subline: count == 1 ? '1 job bheji gayi' : '$count jobs bheji gayi',
      trailing: const KitStatusCheck(),
    );
  }

  /// "AB KYA HOGA" — the what-happens-next list, on one shared card above the
  /// applications rather than a per-row repeat.
  Widget _whatNextCard() {
    return KitCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const KitMicroLabel('AB KYA HOGA'),
          const SizedBox(height: 10),
          Text(
            '1. Company aapka resume dekhegi\n'
            '2. Pasand aaya toh call ya WhatsApp aayega\n'
            '3. Interview ki date fix hogi',
            style: OnboardingTypography.inter(
              size: 14,
              height: 1.6,
              color: OnboardingColors.ink600,
            ),
          ),
        ],
      ),
    );
  }

  /// One application as a [BbJobCard]. The row already holds the REAL job facts,
  /// so it hands them over as `extra` on tap (there is no worker-facing
  /// job-detail fetch beyond the id, and nothing is synthesised). The row's REAL
  /// `action` rides along so the detail screen shows the applied status instead
  /// of an apply CTA (WA-2). The right-hand meta shows the "Applied · …" label.
  Widget _appliedCard(BuildContext context, AppliedJob job) {
    final String place = (job.area != null && job.area!.isNotEmpty)
        ? '${job.area}, ${job.city}'
        : job.city;
    // "skill · place" as the subtitle line (company is PII, always null). Prefer
    // the human matched-skill LABEL ("MIG Welder") when the feed carries one;
    // else HUMANISE the legacy `trade_key` ("cnc_operator" → "CNC Operator") —
    // never the slug itself, and never a raw `mskill_*` id (the #1027
    // guarantee; under MATCH_V1 trade_key IS that id, and [tradeKeyLabel]
    // returns '' for it so the line drops to the place alone).
    //
    // #1051: the applications API sends `trade_key` but NOT
    // `matched_skill_label`, so a label-only read dropped the trade line for
    // every legacy application (all 17 in production). This keeps it without
    // ever surfacing an id.
    final String? label = job.matchedSkillLabel;
    final String legacyTrade = tradeKeyLabel(job.tradeKey);
    final String? skill = (label != null && label.isNotEmpty)
        ? label
        : (legacyTrade.isEmpty ? null : legacyTrade);
    return BbJobCard(
      data: BbJobCardData(
        title: job.title,
        // The trade rides its OWN line; the location row keeps its pin for a
        // location only (see [BbJobCardData.trade]).
        trade: (skill == null || skill.isEmpty) ? null : skill,
        place: place,
        metaRight: appliedRelativeLabel(job.createdAt),
      ),
      onTitleTap: () => context.pushOnce(
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

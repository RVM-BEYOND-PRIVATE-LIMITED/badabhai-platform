import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import 'cubit/agency_jobs_cubit.dart';
import 'edit_agency_job_screen.dart';
import 'widgets/job_card_actions.dart';
import 'widgets/job_list_format.dart';
import 'widgets/jobs_empty_state.dart';
import 'widgets/trade_posting_fields.dart' show humaniseTradeKey;

/// My jobs — AGENCY branch. Lists the agency session's own faceless postings
/// (`GET /payer/agency/jobs`): trade label · title · city/area · pay & experience
/// bands (if set) · applicants-received · a status pill (open/paused/closed). A
/// non-closed row has ONE main action (Applicants) plus a "⋯" sheet with Edit
/// and Close — a Close always asks first (#2594); a closed row is terminal. No
/// postings yet → [JobsEmptyState]. Agent-only — the shell only mounts this for
/// an agency session (the routes 403 for a company).
///
/// NO PAUSE BUTTON (backend contract): on the deployed backend
/// `POST /payer/agency/jobs/:id/pause` maps to a TERMINAL close ("pause ==
/// close", Phase-1). A button labelled Pause that permanently closes the job is
/// a lie about server state, so until the backend ships a real paused state +
/// resume (RVM repo issue #1202) a non-closed row offers Close ONLY. A `paused`
/// row (should the model carry one) renders a READ-ONLY pill and still offers
/// Close only — never a Pause or Resume control.
class AgencyJobsView extends StatelessWidget {
  const AgencyJobsView({super.key, required this.onPost, this.onApplicants});

  final VoidCallback onPost;

  /// Opens the candidate/applicant feed (the Find tab), shared with company.
  final VoidCallback? onApplicants;

  @override
  Widget build(BuildContext context) {
    return BlocProvider<AgencyJobsCubit>(
      create: (_) => locator<AgencyJobsCubit>()..load(),
      child: _AgencyJobsBody(onPost: onPost, onApplicants: onApplicants),
    );
  }
}

class _AgencyJobsBody extends StatelessWidget {
  const _AgencyJobsBody({required this.onPost, this.onApplicants});

  final VoidCallback onPost;
  final VoidCallback? onApplicants;

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
            icon: Icons.wifi_off_rounded,
            title: 'Could not load jobs',
            action: BbButton(
              label: 'Retry',
              onPressed: () => context.read<AgencyJobsCubit>().load(),
            ),
          );
        }

        // A new account has no postings: say what the tab is for and offer
        // the next step (#2594).
        if (state.jobs.isEmpty) return JobsEmptyState(onPost: onPost);

        return ListView.builder(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          // Lazy: header at index 0, then one job card per index — off-screen
          // postings are not built up front.
          itemCount: 1 + state.jobs.length,
          itemBuilder: (BuildContext context, int index) {
            if (index != 0) {
              final AgencyJobView job = state.jobs[index - 1];
              return Padding(
                // Keyed by job so a Close's refetch settles THIS card in place
                // and never hands its state to another row.
                key: ValueKey<String>(job.id),
                padding: const EdgeInsets.only(bottom: AppSpacing.s3),
                child: _AgencyJobCard(job: job, onApplicants: onApplicants),
              );
            }
            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
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
                            style: AppTypography.eyebrow(
                                color: AppColors.textMuted),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            countLabel(state.jobs.length, 'job'),
                            style: AppTypography.header(
                              size: AppTypography.sizeXl,
                              weight: FontWeight.w800,
                            ),
                          ),
                        ],
                      ),
                    ),
                    BbButton(
                      label: 'Post',
                      // md (44px) not sm — a loud primary CTA clears the 48px tap
                      // floor (#1082).
                      size: BbButtonSize.md,
                      iconLeft: Icons.add_rounded,
                      onPressed: onPost,
                    ),
                  ],
                ),
                const SizedBox(height: AppSpacing.s3),
              ],
            );
          },
        );
      },
    );
  }
}

class _AgencyJobCard extends StatefulWidget {
  const _AgencyJobCard({required this.job, this.onApplicants});

  final AgencyJobView job;
  final VoidCallback? onApplicants;

  @override
  State<_AgencyJobCard> createState() => _AgencyJobCardState();
}

class _AgencyJobCardState extends State<_AgencyJobCard> {
  /// A Close is in flight — the "⋯" shows a spinner and takes no taps, so one
  /// confirm sends one request.
  bool _closing = false;

  AgencyJobView get job => widget.job;

  // Green is reserved for VERIFIED only (kit law); an open posting is an
  // active/info state, not success green. Paused mirrors the company card's
  // warning tone; closed is neutral/terminal.
  (String, BbBadgeTone) get _pill => switch (job.status) {
        'open' => ('Open', BbBadgeTone.info),
        'paused' => ('Paused', BbBadgeTone.warning),
        _ => ('Closed', BbBadgeTone.neutral),
      };

  /// The "⋯" sheet: Edit and Close ONLY — see the class doc of
  /// [AgencyJobsView] for why there is no Pause. A Close always asks first.
  Future<void> _openMenu() async {
    final AgencyJobsCubit cubit = context.read<AgencyJobsCubit>();
    final JobMenuAction? picked = await showJobActionSheet(
      context,
      jobTitle: job.title,
      actions: const <JobMenuAction>[JobMenuAction.edit, JobMenuAction.close],
    );
    if (picked == null || !mounted) return;
    if (picked == JobMenuAction.edit) {
      _openEdit(cubit);
    } else if (picked == JobMenuAction.close) {
      final bool confirmed =
          await showCloseJobConfirm(context, jobTitle: job.title);
      if (confirmed && mounted) await _close(cubit);
    }
  }

  Future<void> _close(AgencyJobsCubit cubit) async {
    setState(() => _closing = true);
    final JobActionResult result = await cubit.closePosting(job.id);
    if (!mounted) return;
    setState(() => _closing = false);
    showJobActionToast(
      context,
      JobLifecycleAction.close,
      success: result.success,
      message: result.message,
    );
  }

  @override
  Widget build(BuildContext context) {
    final (String label, BbBadgeTone tone) = _pill;
    final List<String> meta = <String>[
      job.locationText,
      if (job.payRangeLabel != null) job.payRangeLabel!,
      if (job.experienceLabel != null) job.experienceLabel!,
      // #2548 — read-only until level editing in the app is decided (Q1).
      if (job.tradeLevel != null && job.tradeLevel!.isNotEmpty)
        'Level needed: ${humaniseTradeKey(job.tradeLevel!)}',
    ];

    // A closed card fades to the row dim and collapses as its actions go — the
    // job stays listed, only its card settles (#2594).
    return JobCardSurface(
      dimmed: job.isClosed,
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
                      style: AppTypography.heading(
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
            '${countLabel(job.applicantsReceived, 'applicant')} received',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
          const SizedBox(height: AppSpacing.s3),
          _actions(),
        ],
      ),
    );
  }

  /// Push the edit form, handing it the SHARED [AgencyJobsCubit] so a saved edit
  /// refetches the list. Named route so the crash reporter tags the screen.
  void _openEdit(AgencyJobsCubit cubit) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        settings: const RouteSettings(name: 'payer/agency-job-edit'),
        builder: (_) => EditAgencyJobScreen(job: job, cubit: cubit),
      ),
    );
  }

  /// ONE main action plus the "⋯" (#2594). The FIND tab is the candidate/
  /// applicant feed for BOTH session kinds; Applicants opens it from the job
  /// the agent is looking at. Edit and Close sit behind the "⋯" — open OR
  /// paused (the server rejects a PATCH on a closed row, and a close is
  /// terminal).
  Widget _actions() {
    if (job.isClosed) {
      return Text(
        'This job is closed.',
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.textMuted,
        ),
      );
    }
    return JobCardActionRow(
      main: BbButton(
        label: 'Applicants',
        // Navy commitment — the single haldi on this view is the header 'Post'.
        variant: BbButtonVariant.navy,
        size: BbButtonSize.md,
        iconLeft: Icons.groups_rounded,
        onPressed: widget.onApplicants,
      ),
      jobTitle: job.title,
      moreBusy: _closing,
      onMore: _closing ? null : _openMenu,
    );
  }
}

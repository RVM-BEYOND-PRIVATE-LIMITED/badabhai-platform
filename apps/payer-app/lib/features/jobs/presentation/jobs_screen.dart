import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/job_posting_chat_models.dart';
import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/session/app_session_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_new_item_highlight.dart';
import '../../../core/widgets/bb_progress.dart';
import '../../../core/error/payer_failure.dart';
import '../../../core/widgets/bb_refresh.dart';
import '../../../core/widgets/bb_skeleton.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_tab_scope.dart';
import '../../job_posting_chat/presentation/cubit/chat_sessions_cubit.dart';
import 'agency_jobs_screen.dart';
import 'cubit/jobs_cubit.dart';
import 'edit_company_job_screen.dart';
import 'widgets/job_card_actions.dart';
import 'widgets/job_list_format.dart';
import 'widgets/jobs_empty_state.dart';
import 'widgets/trade_posting_fields.dart' show humaniseTradeKey;

/// Entry point label for the conversational create path (ADR-0035).
const String kAiPostLabel = 'Create with AI';

/// Resume-card copy for a chat left in progress — possibly on another device.
const String kResumeChatTitle = 'Continue your job posting';

/// My jobs — role-branched on [AppSession.role].
///
///  - COMPANY: a REAL row (`job.id != null`, from `GET /payer/job-postings`)
///    renders the honest [_RealJobCard] (lifecycle pill + only the LEGAL actions
///    for that state: one main action and a "⋯" sheet, #2594); a MOCK row
///    (`id == null`) keeps the rich [_JobCard] so MOCK stays walkable. Two
///    create paths sit side by side: the existing manual form ([onPost]) and
///    the AI-assisted chat ([onAiPost], ADR-0035) — the chat is ADDITIVE and
///    replaces nothing. No postings yet → [JobsEmptyState], never a blank list.
///  - AGENCY: the faceless agency postings (`GET /payer/agency/jobs`) render via
///    [AgencyJobsView] (trade · city/area · pay & experience bands · applicants ·
///    status pill; Applicants plus a "⋯" with Edit/Close). The agent routes
///    403 for a company, so they are only ever mounted here for an agency
///    session.
///
/// NO MONEY ACTION EXISTS ON THIS SCREEN (owner decision). The one-tap
/// "Buy plan" / "Boost reach" / "Top up quota" sheet that used to live on the
/// open/paused cards charged real money from inside a store-distributed app —
/// exactly what App Store / Play Store IAP policy governs. Its "Manage plan on
/// web" replacement is gone too (#2589 — no payment information of any kind in
/// the app); plans, boosts and top-ups live on payer-web only.
///
/// AGENCY DOES NOT GET THE AI PATH: ADR-0035's publish step calls
/// `JobPostingsService.createForPayer`, which writes a COMPANY `job_postings`
/// row. An agency's My-jobs list reads `/payer/agency/jobs`, so a posting
/// published from the chat would not appear in it — offering the entry point
/// there would promise a posting the agent could never find.
class JobsScreen extends StatelessWidget {
  const JobsScreen({
    super.key,
    required this.onPost,
    this.onAiPost,
    this.onApplicants,
    this.highlight,
  });

  final VoidCallback onPost;

  /// The posting the payer just created (#2596): its card is scrolled into
  /// view and briefly tinted, once. Null on an ordinary visit.
  final BbHighlightRequest? highlight;

  /// Opens the candidate/applicant feed (the Find tab). Optional so existing
  /// mounts and tests keep working; the shell wires it for both sessions.
  final VoidCallback? onApplicants;

  /// Opens the AI-assisted chat. A non-null argument RESUMES that session
  /// (cross-device pickup); null starts a fresh one. Optional so existing
  /// mounts (and tests) keep working without the chat wired.
  final void Function(String? resumeSessionId)? onAiPost;

  @override
  Widget build(BuildContext context) {
    // The session role is locked at login — branch the whole surface on it so a
    // company never touches the agent-gated routes and vice-versa.
    final bool isAgency = locator<AppSessionCubit>().state?.isAgency ?? false;
    if (isAgency) {
      return AgencyJobsView(
        onPost: onPost,
        onApplicants: onApplicants,
        highlight: highlight,
      );
    }
    return BlocProvider<JobsCubit>(
      create: (_) => locator<JobsCubit>()..load(),
      // The cross-device pickup read, nested so both cubits are in scope for the
      // view. Loaded alongside the postings so a chat started in the web portal
      // is already on screen when the tab opens.
      child: BlocProvider<ChatSessionsCubit>(
        create: (_) => locator<ChatSessionsCubit>()..load(),
        // #2592 — a return to the tab re-reads both quietly.
        child: BbTabRefreshListener(
          onRefresh: _JobsView.refreshQuietly,
          child: _JobsView(
            onPost: onPost,
            onAiPost: onAiPost,
            onApplicants: onApplicants,
            highlight: highlight,
          ),
        ),
      ),
    );
  }
}

class _JobsView extends StatelessWidget {
  const _JobsView({
    required this.onPost,
    this.onAiPost,
    this.onApplicants,
    this.highlight,
  });

  final VoidCallback onPost;
  final void Function(String? resumeSessionId)? onAiPost;
  final VoidCallback? onApplicants;
  final BbHighlightRequest? highlight;

  /// #2592 — the quiet re-read behind pull-to-refresh and a return to the
  /// tab: the postings stay on screen, and a failure says why in a toast. The
  /// resume card re-reads too (it degrades silently by design).
  static Future<void> refreshQuietly(BuildContext context) {
    context.read<ChatSessionsCubit>().load();
    return refreshWithToast(context, context.read<JobsCubit>().refresh);
  }

  @override
  Widget build(BuildContext context) {
    // #2592 — job-card skeletons while the postings load; the list
    // cross-fades in over them.
    return BbLoadingBuilder<JobsCubit, JobsState>(
      isLoading: (JobsState s) =>
          s.status == JobsStatus.loading || s.status == JobsStatus.initial,
      skeleton: const BbSkeletonList(
        header: BbSkeletonHeader(),
        row: BbSkeletonJobRow(),
        count: 3,
        semanticLabel: 'Loading your jobs',
      ),
      builder: (BuildContext context, JobsState state) {
        if (state.status == JobsStatus.error) {
          final PayerFailure failure =
              state.failure ?? const PayerFailure(PayerFailureKind.unknown);
          return BbStatusView(
            icon: failure.icon,
            title: failure.title,
            subtitle: failure.message,
            action: BbButton(
              label: failure.isSessionExpired ? 'Log in' : 'Retry',
              onPressed: () => context.read<JobsCubit>().load(),
            ),
          );
        }

        // A new account has no postings: say what the tab is for and offer
        // the next step (#2594) — the AI path too, when it is wired. #2592 —
        // it pulls to refresh too (a job posted from the web portal).
        if (state.jobs.isEmpty) {
          return BbRefreshIndicator(
            onRefresh: () => refreshQuietly(context),
            child: JobsEmptyState(
              onPost: onPost,
              footer:
                  onAiPost == null ? null : _AiPostPath(onAiPost: onAiPost!),
            ),
          );
        }

        final Widget list = ListView.builder(
          // Over-scrolls even when short, so pull-to-refresh always works.
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          // Lazy: header at index 0, then one job card per index — off-screen
          // postings are not built up front (mirrors the applicant-feed fix).
          itemCount: 1 + state.jobs.length,
          itemBuilder: (BuildContext context, int index) {
            if (index != 0) {
              final JobPosting job = state.jobs[index - 1];
              return Padding(
                // Keyed by posting so an action's refetch updates THIS card in
                // place (it settles closed) and never hands its state to
                // another row.
                key: job.id == null ? null : ValueKey<String>(job.id!),
                padding: const EdgeInsets.only(bottom: AppSpacing.s3),
                // #2596 — the just-posted card scrolls into view, tinted once.
                child: BbNewItemHighlight(
                  active: highlight?.claim(job.id) ?? false,
                  child: job.id == null
                      ? _JobCard(job: job, onApplicants: onApplicants)
                      : _RealJobCard(job: job, onApplicants: onApplicants),
                ),
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
                            'MY JOB POSTINGS',
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
                if (onAiPost != null) ...<Widget>[
                  const SizedBox(height: AppSpacing.s3),
                  _AiPostPath(onAiPost: onAiPost!),
                ],
                const SizedBox(height: AppSpacing.s3),
              ],
            );
          },
        );
        return BbRefreshIndicator(
          onRefresh: () => refreshQuietly(context),
          child: list,
        );
      },
    );
  }
}

/// The ADDITIVE second create path (ADR-0035) — "Create with AI" plus the
/// cross-device resume card — shared by the list header and the empty state.
/// The manual form stays the default for a payer who knows the fields.
class _AiPostPath extends StatelessWidget {
  const _AiPostPath({required this.onAiPost});

  final void Function(String? resumeSessionId) onAiPost;

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        BbButton(
          label: kAiPostLabel,
          variant: BbButtonVariant.tonal,
          size: BbButtonSize.sm,
          iconLeft: Icons.auto_awesome_rounded,
          block: true,
          onPressed: () => onAiPost(null),
        ),
        _ResumeChatCard(onResume: onAiPost),
      ],
    );
  }
}

/// The MOBILE side of ADR-0035's cross-device pickup: a chat the payer left in
/// progress — on this phone or, just as often, in the web portal — offered back
/// to them by `GET /payer/job-posting-chat/sessions`.
///
/// Renders NOTHING when there is nothing resumable, and nothing when the read
/// failed (a silent degrade — this is an optional card on a tab whose job is
/// listing postings, so an error banner here would be noise).
class _ResumeChatCard extends StatelessWidget {
  const _ResumeChatCard({required this.onResume});

  final void Function(String? resumeSessionId) onResume;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<ChatSessionsCubit, ChatSessionsState>(
      builder: (BuildContext context, ChatSessionsState state) {
        final JobPostingChatSessionSummary? session = state.mostRecent;
        if (session == null) return const SizedBox.shrink();
        // #1727 — the session now carries the draft's coarse card city, so the
        // row can say WHERE the job is. Appended only when the draft has one: a
        // town outside the closed city list legitimately has none, and a city is
        // never read out of the poster's free-text location label.
        final String where = session.city == null ? '' : ' · ${session.city}';
        final String subtitle = session.roleTitle == null
            ? (session.draftReady
                ? 'Draft ready to publish$where'
                : 'Started on one of your devices$where')
            : '${session.roleTitle}$where · '
                '${session.draftReady ? 'draft ready' : 'in progress'}';
        return Padding(
          padding: const EdgeInsets.only(top: AppSpacing.s3),
          child: BbCard(
            onTap: () => onResume(session.id),
            child: Row(
              children: <Widget>[
                const Icon(Icons.forum_rounded, color: AppColors.brand),
                const SizedBox(width: AppSpacing.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        kResumeChatTitle,
                        style: AppTypography.heading(
                          size: AppTypography.sizeBase,
                          weight: FontWeight.w700,
                        ),
                      ),
                      Text(
                        subtitle,
                        style: AppTypography.body(
                          size: AppTypography.sizeSm,
                          color: AppColors.textMuted,
                        ),
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right_rounded, color: AppColors.textMuted),
              ],
            ),
          ),
        );
      },
    );
  }
}

// ---------------------------------------------------------------------------
// REAL company card — driven by the wire lifecycle string. No fabricated
// quota/counts (the server row has none).
// ---------------------------------------------------------------------------

class _RealJobCard extends StatefulWidget {
  const _RealJobCard({required this.job, this.onApplicants});

  final JobPosting job;
  final VoidCallback? onApplicants;

  @override
  State<_RealJobCard> createState() => _RealJobCardState();
}

class _RealJobCardState extends State<_RealJobCard> {
  /// The lifecycle action in flight for THIS card, or null when idle. Its
  /// controls — and a Pause's Undo — are disabled while it runs, so one tap
  /// sends one request.
  JobLifecycleAction? _busy;

  JobPosting get job => widget.job;

  String get _wire => job.wireStatus ?? 'draft';

  // Green is reserved for VERIFIED only (kit law) — an open posting reads as an
  // active/info state, not a success/money green.
  (String, BbBadgeTone) get _pill => switch (_wire) {
        'open' => ('Open', BbBadgeTone.info),
        'paused' => ('Paused', BbBadgeTone.warning),
        'closed' => ('Closed', BbBadgeTone.neutral),
        _ => ('Draft', BbBadgeTone.neutral),
      };

  /// The "⋯" sheet's actions — the same LEGAL set the stacked buttons offered:
  /// Edit on any non-terminal posting, Pause only while open, Close on a draft
  /// or an open job (the server 409s a close on a paused one).
  List<JobMenuAction> get _menu => switch (_wire) {
        'open' => const <JobMenuAction>[
            JobMenuAction.pause,
            JobMenuAction.edit,
            JobMenuAction.close,
          ],
        'paused' => const <JobMenuAction>[JobMenuAction.edit],
        'closed' => const <JobMenuAction>[],
        _ => const <JobMenuAction>[JobMenuAction.edit, JobMenuAction.close],
      };

  void _setBusy(JobLifecycleAction? action) {
    if (mounted) setState(() => _busy = action);
  }

  /// Runs one lifecycle call on [cubit] (read at tap time, so an Undo still
  /// reaches it from a toast) and reports it as a toast named for [action]. A
  /// successful Pause offers Undo, which resumes the posting. Starting a call
  /// takes the last toast down, so a stale Undo is never left on screen.
  ///
  /// #2635 — the one refusal that is NOT a toast: a job the server will not put
  /// live without one of the 16 trades opens its edit form at the trade
  /// picker, refused there, so the payer picks one instead of reading why.
  Future<void> _run(JobsCubit cubit, JobLifecycleAction action) async {
    final String id = job.id!;
    if (mounted) ScaffoldMessenger.of(context).hideCurrentSnackBar();
    _setBusy(action);
    final JobActionResult result = await switch (action) {
      JobLifecycleAction.publish => cubit.publish(id),
      JobLifecycleAction.pause => cubit.pause(id),
      JobLifecycleAction.resume => cubit.resume(id),
      JobLifecycleAction.close => cubit.closePosting(id),
    };
    _setBusy(null);
    if (!mounted) return;
    if (result.tradeRequired) {
      _openEdit(cubit, tradeRequired: true);
      return;
    }
    if (result.success && action == JobLifecycleAction.pause) {
      showJobUndoToast(
        context,
        title: action.done,
        message: result.message,
        // An Undo that lands while another call runs, or once the job is no
        // longer paused, would only send a duplicate — it sends nothing. Not
        // gated on [mounted]: the lazy list disposes a card scrolled out of
        // view, and its Undo must still resume the job.
        onUndo: () {
          if (_busy == null && _wire == 'paused') {
            _run(cubit, JobLifecycleAction.resume);
          }
        },
      );
      return;
    }
    showJobActionToast(
      context,
      action,
      success: result.success,
      message: result.message,
    );
  }

  /// The "⋯" sheet, then the picked action. A Close always asks first.
  Future<void> _openMenu() async {
    final JobsCubit cubit = context.read<JobsCubit>();
    final JobMenuAction? picked =
        await showJobActionSheet(context, jobTitle: job.title, actions: _menu);
    if (picked == null || !mounted) return;
    switch (picked) {
      case JobMenuAction.pause:
        await _run(cubit, JobLifecycleAction.pause);
      case JobMenuAction.edit:
        _openEdit(cubit);
      case JobMenuAction.close:
        final bool confirmed =
            await showCloseJobConfirm(context, jobTitle: job.title);
        if (confirmed && mounted) await _run(cubit, JobLifecycleAction.close);
    }
  }

  @override
  Widget build(BuildContext context) {
    final (String label, BbBadgeTone tone) = _pill;
    final String? posted =
        job.createdAt == null ? null : readableDate(job.createdAt!);
    final List<String> meta = <String>[
      if (job.locationLabel != null && job.locationLabel!.isNotEmpty)
        job.locationLabel!,
      // #2548 — the posting's level, READ-ONLY here. Editing it in the app is
      // a later decision (owner ruling Q1); the value is whatever the server
      // already stored, never a client default.
      if (job.tradeLevel != null && job.tradeLevel!.isNotEmpty)
        'Level needed: ${humaniseTradeKey(job.tradeLevel!)}',
      if (job.band.isNotEmpty) vacanciesLabel(job.band),
      if (posted != null) 'Posted $posted',
      // Truthful per-posting engagement (backend-sourced); omitted when none.
      if (job.disclosuresCount > 0)
        '${job.disclosuresCount} '
            '${job.disclosuresCount == 1 ? 'résumé' : 'résumés'} downloaded',
    ];

    // A closed card fades to the row dim and collapses as its actions go — the
    // job stays listed, only its card settles (#2594).
    return JobCardSurface(
      dimmed: _wire == 'closed',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: <Widget>[
              Expanded(
                child: Text(
                  job.title,
                  style: AppTypography.heading(
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
          // REAL, backend-sourced signals: a Verified badge once ops approves the
          // posting, a Boosted badge when a boost is active, and the applicant-
          // visibility quota meter when a plan exists (used / effective quota).
          // Each is absent until its backing state exists — no fabricated badge.
          if (job.verified || job.boosted) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            Wrap(
              spacing: AppSpacing.chipGap,
              runSpacing: AppSpacing.chipGap,
              children: <Widget>[
                if (job.verified)
                  const BbBadge(
                    'Verified job',
                    tone: BbBadgeTone.success,
                    icon: Icons.verified_user_rounded,
                  ),
                if (job.boosted)
                  const BbBadge(
                    'Boosted',
                    tone: BbBadgeTone.brand,
                    icon: Icons.rocket_launch_rounded,
                  ),
              ],
            ),
          ],
          if (job.quota > 0) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            BbProgress(
              value: job.progress,
              label: 'Applicant views',
              countText: '${job.filled}/${job.quota}',
            ),
          ],
          const SizedBox(height: AppSpacing.s3),
          _actions(),
        ],
      ),
    );
  }

  /// Push the edit form, handing it the SHARED [JobsCubit] so a saved edit
  /// refetches the list. Named route so the crash reporter tags the screen.
  /// [tradeRequired] (#2635) opens it at the trade picker, refused there.
  void _openEdit(JobsCubit cubit, {bool tradeRequired = false}) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        settings: const RouteSettings(name: 'payer/job-edit'),
        builder: (_) => EditCompanyJobScreen(
          job: job,
          cubit: cubit,
          tradeRequired: tradeRequired,
        ),
      ),
    );
  }

  /// ONE main action — Publish (draft), Applicants (open), Resume (paused) —
  /// plus the "⋯" for the rest (#2594). Navy commitment: the single haldi on
  /// this view is the header 'Post' CTA, so per-card actions never compete for
  /// it. A closed job is terminal: no actions.
  Widget _actions() {
    if (_wire == 'closed') {
      return Text(
        'This job is closed.',
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.textMuted,
        ),
      );
    }
    final bool idle = _busy == null;
    final List<JobMenuAction> menu = _menu;
    return JobCardActionRow(
      main: _mainAction(idle),
      jobTitle: job.title,
      showMore: menu.isNotEmpty,
      moreBusy: _busy == JobLifecycleAction.pause ||
          _busy == JobLifecycleAction.close,
      onMore: idle ? _openMenu : null,
    );
  }

  Widget _mainAction(bool idle) {
    return switch (_wire) {
      // Opens the Find tab's Applicants view (the shell wires it). Navigation
      // only, so it stays live while a sheet action runs.
      'open' => BbButton(
          label: 'Applicants',
          variant: BbButtonVariant.navy,
          size: BbButtonSize.md,
          iconLeft: Icons.groups_rounded,
          onPressed: widget.onApplicants,
        ),
      'paused' => BbButton(
          label: 'Resume',
          variant: BbButtonVariant.navy,
          size: BbButtonSize.md,
          iconLeft: Icons.play_arrow_rounded,
          loading: _busy == JobLifecycleAction.resume,
          onPressed: idle ? () => _lifecycle(JobLifecycleAction.resume) : null,
        ),
      _ => BbButton(
          label: 'Publish',
          variant: BbButtonVariant.navy,
          size: BbButtonSize.md,
          iconLeft: Icons.send_rounded,
          loading: _busy == JobLifecycleAction.publish,
          onPressed: idle ? () => _lifecycle(JobLifecycleAction.publish) : null,
        ),
    };
  }

  /// A main-button lifecycle call; the cubit is read at tap time.
  void _lifecycle(JobLifecycleAction action) =>
      _run(context.read<JobsCubit>(), action);
}

// ---------------------------------------------------------------------------
// MOCK rich card (unchanged) — quota bar + Verified/Boosted badges. Only rendered
// for canned MOCK rows (id == null); never for a REAL server row.
// ---------------------------------------------------------------------------

class _JobCard extends StatelessWidget {
  const _JobCard({required this.job, this.onApplicants});

  final JobPosting job;
  final VoidCallback? onApplicants;

  @override
  Widget build(BuildContext context) {
    final bool dim = job.status == JobStatus.filled;
    // Green stays reserved for VERIFIED — a live posting is an active/info tone.
    final BbBadgeTone statusTone = switch (job.status) {
      JobStatus.live => BbBadgeTone.info,
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
                  style: AppTypography.heading(
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
            '${job.band} · ${countLabel(job.applicants, 'applicant')} · '
            '${countLabel(job.unlocks, 'unlock')} used',
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
          if (job.verified || job.boosted) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            Wrap(
              spacing: AppSpacing.chipGap,
              runSpacing: AppSpacing.chipGap,
              children: <Widget>[
                if (job.verified)
                  const BbBadge(
                    'Verified job',
                    tone: BbBadgeTone.success,
                    icon: Icons.verified_user_rounded,
                  ),
                if (job.boosted)
                  const BbBadge(
                    'Boosted',
                    tone: BbBadgeTone.brand,
                    icon: Icons.rocket_launch_rounded,
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
          // The 'Boost' button that used to sit beside this was removed with the
          // rest of the money surface: it was a dead no-op that still advertised
          // an in-app purchase, which is the store-policy risk this slice closes.
          BbButton(
            label: 'Applicants',
            variant: BbButtonVariant.secondary,
            size: BbButtonSize.sm,
            iconLeft: Icons.groups_rounded,
            block: true,
            onPressed: onApplicants,
          ),
        ],
      ),
    );
  }
}

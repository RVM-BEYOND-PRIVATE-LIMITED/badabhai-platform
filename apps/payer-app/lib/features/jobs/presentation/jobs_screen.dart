import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../core/config/app_config.dart';
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
import '../../../core/widgets/bb_progress.dart';
import '../../../core/error/payer_failure.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import '../../job_posting_chat/presentation/cubit/chat_sessions_cubit.dart';
import 'agency_jobs_screen.dart';
import 'cubit/jobs_cubit.dart';
import 'edit_company_job_screen.dart';

/// Opens an external URL. Overridable so widget tests can assert WHERE a link
/// went without a platform channel (`launchUrl` throws MissingPluginException
/// under `flutter test`).
typedef ExternalUrlLauncher = Future<bool> Function(Uri url);

/// Production launcher: hand the url to the OS browser, never an in-app webview
/// — the payer signs in and pays on the web portal, outside this app.
Future<bool> defaultExternalUrlLauncher(Uri url) =>
    launchUrl(url, mode: LaunchMode.externalApplication);

/// The seam a "manage this on the web" link leaves through. Production must
/// always leave this as [defaultExternalUrlLauncher].
@visibleForTesting
ExternalUrlLauncher jobsExternalUrlLauncher = defaultExternalUrlLauncher;

/// Label of the external affordance that REPLACED the in-app purchase actions.
const String kManagePlanOnWebLabel = 'Manage plan on web';

/// Says the missing capability out loud on the screen, so "where do I buy a
/// plan?" is answered here instead of read as a bug (the same honesty the
/// Credits screen already applies to buying credits).
const String kManagePlanOnWebNote =
    'Plans, boosts and quota top-ups are managed on the BadaBhai website.';

/// Entry point label for the conversational create path (ADR-0035).
const String kAiPostLabel = 'Create with AI';

/// Resume-card copy for a chat left in progress — possibly on another device.
const String kResumeChatTitle = 'Continue your job posting';

/// My jobs — role-branched on [AppSession.role].
///
///  - COMPANY: a REAL row (`job.id != null`, from `GET /payer/job-postings`)
///    renders the honest [_RealJobCard] (lifecycle pill + only the LEGAL actions
///    for that state); a MOCK row (`id == null`) keeps the rich [_JobCard] so
///    MOCK stays walkable. Two create paths sit side by side: the existing
///    manual form ([onPost]) and the AI-assisted chat ([onAiPost], ADR-0035) —
///    the chat is ADDITIVE and replaces nothing.
///  - AGENCY: the faceless agency postings (`GET /payer/agency/jobs`) render via
///    [AgencyJobsView] (trade · city/area · pay & experience bands · applicants ·
///    open/closed pill with Pause/Close). The agent routes 403 for a company, so
///    they are only ever mounted here for an agency session.
///
/// NO MONEY ACTION EXISTS ON THIS SCREEN (owner decision). The one-tap
/// "Buy plan" / "Boost reach" / "Top up quota" sheet that used to live on the
/// open/paused cards charged real money from inside a store-distributed app —
/// exactly what App Store / Play Store IAP policy governs. It is replaced by
/// [kManagePlanOnWebLabel], an external link to the web portal. The API-client
/// methods and the backend endpoints are untouched.
///
/// AGENCY DOES NOT GET THE AI PATH: ADR-0035's publish step calls
/// `JobPostingsService.createForPayer`, which writes a COMPANY `job_postings`
/// row. An agency's My-jobs list reads `/payer/agency/jobs`, so a posting
/// published from the chat would not appear in it — offering the entry point
/// there would promise a posting the agent could never find.
class JobsScreen extends StatelessWidget {
  const JobsScreen({super.key, required this.onPost, this.onAiPost});

  final VoidCallback onPost;

  /// Opens the AI-assisted chat. A non-null argument RESUMES that session
  /// (cross-device pickup); null starts a fresh one. Optional so existing
  /// mounts (and tests) keep working without the chat wired.
  final void Function(String? resumeSessionId)? onAiPost;

  @override
  Widget build(BuildContext context) {
    // The session role is locked at login — branch the whole surface on it so a
    // company never touches the agent-gated routes and vice-versa.
    final bool isAgency = locator<AppSessionCubit>().state?.isAgency ?? false;
    if (isAgency) return AgencyJobsView(onPost: onPost);
    return BlocProvider<JobsCubit>(
      create: (_) => locator<JobsCubit>()..load(),
      // The cross-device pickup read, nested so both cubits are in scope for the
      // view. Loaded alongside the postings so a chat started in the web portal
      // is already on screen when the tab opens.
      child: BlocProvider<ChatSessionsCubit>(
        create: (_) => locator<ChatSessionsCubit>()..load(),
        child: _JobsView(onPost: onPost, onAiPost: onAiPost),
      ),
    );
  }
}

class _JobsView extends StatelessWidget {
  const _JobsView({required this.onPost, this.onAiPost});

  final VoidCallback onPost;
  final void Function(String? resumeSessionId)? onAiPost;

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<JobsCubit, JobsState>(
      builder: (BuildContext context, JobsState state) {
        if (state.status == JobsStatus.loading ||
            state.status == JobsStatus.initial) {
          return const BbStatusView.loading();
        }
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
                  // md (44px) not sm — a loud primary CTA clears the 48px tap
                  // floor (#1082).
                  size: BbButtonSize.md,
                  iconLeft: Icons.add,
                  onPressed: onPost,
                ),
              ],
            ),
            if (onAiPost != null) ...<Widget>[
              const SizedBox(height: AppSpacing.s3),
              // ADDITIVE second create path (ADR-0035). The manual form above is
              // untouched and stays the default for a payer who knows the fields.
              BbButton(
                label: kAiPostLabel,
                variant: BbButtonVariant.tonal,
                size: BbButtonSize.sm,
                iconLeft: Icons.auto_awesome,
                block: true,
                onPressed: () => onAiPost!(null),
              ),
              _ResumeChatCard(onResume: onAiPost!),
            ],
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
        final String subtitle = session.roleTitle == null
            ? (session.draftReady
                ? 'Draft ready to publish'
                : 'Started on one of your devices')
            : '${session.roleTitle} · '
                '${session.draftReady ? 'draft ready' : 'in progress'}';
        return Padding(
          padding: const EdgeInsets.only(top: AppSpacing.s3),
          child: BbCard(
            onTap: () => onResume(session.id),
            child: Row(
              children: <Widget>[
                const Icon(Icons.forum_outlined, color: AppColors.brand),
                const SizedBox(width: AppSpacing.s3),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        kResumeChatTitle,
                        style: AppTypography.display(
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
                const Icon(Icons.chevron_right, color: AppColors.textMuted),
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

class _RealJobCard extends StatelessWidget {
  const _RealJobCard({required this.job});

  final JobPosting job;

  String get _wire => job.wireStatus ?? 'draft';

  // Green is reserved for VERIFIED only (kit law) — an open posting reads as an
  // active/info state, not a success/money green.
  (String, BbBadgeTone) get _pill => switch (_wire) {
        'open' => ('Open', BbBadgeTone.info),
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

  /// Hands the payer to the WEB portal to manage plans / boosts / top-ups.
  ///
  /// This REPLACED a one-tap in-app purchase sheet ("Buy plan · Standard",
  /// "Buy plan · Pro", "Boost reach", "Top up quota") that charged real money
  /// behind a confirm dialog. Selling a digital entitlement from inside a
  /// store-distributed app is precisely what the App Store / Play Store IAP
  /// rules cover, so the app now has zero money-spending actions and points
  /// outward instead.
  ///
  /// Falls back to an honest toast (no dead-end, no fabricated link) when no
  /// usable web origin is configured or nothing on the device can open it.
  Future<void> _openPlanOnWeb(BuildContext context) async {
    final String? base = resolvePayerWebUrl();
    bool opened = false;
    if (base != null) {
      final Uri? url = Uri.tryParse('$base/jobs/${job.id}');
      if (url != null) {
        try {
          opened = await jobsExternalUrlLauncher(url);
        } catch (_) {
          opened = false;
        }
      }
    }
    if (opened || !context.mounted) return;
    showBbToast(
      context,
      title: 'Open on web',
      message: kManagePlanOnWebNote,
      icon: Icons.open_in_new,
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
      // Truthful per-posting engagement (backend-sourced); omitted when none.
      if (job.disclosuresCount > 0)
        '${job.disclosuresCount} '
            '${job.disclosuresCount == 1 ? 'résumé' : 'résumés'} downloaded',
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
          if (job.quota > 0) ...<Widget>[
            const SizedBox(height: AppSpacing.s3),
            BbProgress(
              value: job.progress,
              label: 'Applicant views',
              countText: '${job.filled}/${job.quota}',
            ),
          ],
          const SizedBox(height: AppSpacing.s3),
          ..._actions(context),
          // Edit content (role title / location / vacancy band) — available on
          // any non-terminal posting. A closed job is terminal, so no edit.
          if (_wire != 'closed') ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            BbButton(
              label: 'Edit details',
              variant: BbButtonVariant.secondary,
              size: BbButtonSize.sm,
              iconLeft: Icons.edit_outlined,
              block: true,
              onPressed: () => _openEdit(context),
            ),
          ],
        ],
      ),
    );
  }

  /// Push the edit form, handing it the SHARED [JobsCubit] so a saved edit
  /// refetches the list. Named route so the crash reporter tags the screen.
  void _openEdit(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        settings: const RouteSettings(name: 'payer/job-edit'),
        builder: (_) => EditCompanyJobScreen(
          job: job,
          cubit: context.read<JobsCubit>(),
        ),
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
                  // Navy commitment — the single haldi on this view is the header
                  // 'Post' CTA, so per-card actions never compete for it.
                  variant: BbButtonVariant.navy,
                  size: BbButtonSize.md,
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
          _manageOnWeb(context),
        ];
      case 'paused':
        return <Widget>[
          BbButton(
            label: 'Resume',
            // Navy commitment — keeps the header 'Post' as the view's sole haldi.
            variant: BbButtonVariant.navy,
            size: BbButtonSize.md,
            iconLeft: Icons.play_arrow,
            block: true,
            onPressed: () => _run(context, (JobsCubit c) => c.resume(id)),
          ),
          const SizedBox(height: AppSpacing.s2),
          _manageOnWeb(context),
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

  /// The external "manage plan on web" affordance + the one-line note that says
  /// out loud why there is no purchase button here.
  Widget _manageOnWeb(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        BbButton(
          label: kManagePlanOnWebLabel,
          variant: BbButtonVariant.secondary,
          size: BbButtonSize.sm,
          iconLeft: Icons.open_in_new,
          block: true,
          onPressed: () => _openPlanOnWeb(context),
        ),
        const SizedBox(height: AppSpacing.s1),
        Text(
          kManagePlanOnWebNote,
          style: AppTypography.body(
            size: AppTypography.sizeXs,
            color: AppColors.textMuted,
          ),
        ),
      ],
    );
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
              spacing: AppSpacing.chipGap,
              runSpacing: AppSpacing.chipGap,
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
          // The 'Boost' button that used to sit beside this was removed with the
          // rest of the money surface: it was a dead no-op that still advertised
          // an in-app purchase, which is the store-policy risk this slice closes.
          BbButton(
            label: 'Applicants',
            variant: BbButtonVariant.secondary,
            size: BbButtonSize.sm,
            iconLeft: Icons.groups_outlined,
            block: true,
            onPressed: () {},
          ),
        ],
      ),
    );
  }
}

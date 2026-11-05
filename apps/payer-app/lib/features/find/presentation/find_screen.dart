import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/payer_failure.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/name_mask.dart';
import '../../../core/widgets/bb_avatar.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_card.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_refresh.dart';
import '../../../core/widgets/bb_shake.dart';
import '../../../core/widgets/bb_skeleton.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_tab_scope.dart';
import '../../../core/widgets/bb_toast.dart';
import '../../../core/widgets/bb_unlock_dialog.dart';
import 'candidate_search_view.dart';
import 'cubit/candidate_search_cubit.dart';
import 'cubit/find_cubit.dart';
import 'disclosure_history_screen.dart';
import 'reveal_args.dart';
import 'widgets/candidate_card.dart' show CandidateCard;
import 'widgets/find_pinned_list.dart';
import 'widgets/find_view_switch.dart';
import 'widgets/unlock_button.dart';

export 'widgets/find_view_switch.dart' show FindView;

/// Find's page title (#2593) — shown ONCE, above the view switch. Each view
/// used to repeat it under the switch.
const String kFindTitle = 'Browse & unlock';

/// Find — two views behind one segmented control (owner rulings 2026-11-03):
///
///  - ALL CANDIDATES (the DEFAULT, company and agency alike) — every worker in
///    the eligible pool, masked, with the full filter set
///    ([CandidateSearchView], `POST /payer/candidates/search`).
///  - APPLICANTS — the per-job feed, UNCHANGED ([_FindView] below). MOCK mode
///    shows the rich global candidate list (redacted name + "••" avatar). REAL
///    mode shows the FACELESS per-job applicant feed: a masked label derived
///    from the worker UUID, coarse trade/city/exp chips, a red "Hot" flag on a
///    minority, up to two SOFT signal chips (never a number/score), and an
///    Unlock button (its dialog states the 1 credit). No demographics in either.
///
/// Both views lead to the same unlock and the same reveal ([onReveal]).
///
/// #2593 — the page title comes first, then the switch (its thumb slides);
/// each view pins its filters and counts above its list.
class FindScreen extends StatefulWidget {
  const FindScreen({
    super.key,
    required this.onReveal,
    this.initialView = FindView.allCandidates,
    this.initialJobId,
    this.applicantsEpoch = 0,
  });

  final ValueChanged<RevealArgs> onReveal;

  /// The view the tab opens on. The shell passes [FindView.applicants] when a
  /// Jobs card's "Applicants" button opened Find.
  final FindView initialView;

  /// The posting whose "Applicants" button opened Find (#2593): the Applicants
  /// view opens on THAT job. Null opens it on the first open job.
  final String? initialJobId;

  /// #2592 — the shell bumps this for each Jobs card "Applicants" tap: the
  /// Applicants view is rebuilt on a fresh cubit (a fresh feed), while All
  /// candidates keeps its filters, loaded pages and scroll.
  final int applicantsEpoch;

  @override
  State<FindScreen> createState() => _FindScreenState();
}

class _FindScreenState extends State<FindScreen>
    with BbTabReturnMixin<FindScreen> {
  late FindView _view = widget.initialView;

  /// The views opened so far. A view mounts — and loads — on its FIRST open,
  /// then stays alive while hidden: a peek at Applicants never costs the
  /// All-candidates filters, loaded pages or scroll, and a view the payer never
  /// opens costs no request (the shell's #382 rule, one level down).
  late final Set<FindView> _opened = <FindView>{widget.initialView};

  void _select(FindView view) {
    if (view == _view) return;
    setState(() {
      _view = view;
      _opened.add(view);
    });
  }

  /// #2592 — the shell keeps Find alive across tab switches, so a return (or
  /// a re-tap of the tab) still opens the view it asks for — the nav tab and
  /// Home's Browse: All candidates (owner rulings 2026-11-03). A return
  /// re-reads the view it opens quietly; the hidden one re-reads when the
  /// payer next switches to it ([BbTabRefreshListener]). A re-tap reloads
  /// neither.
  @override
  void onTabReturn() => _select(widget.initialView);

  @override
  void onTabReselect() => _select(widget.initialView);

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.s2,
            0,
          ),
          child: Row(
            children: <Widget>[
              Expanded(
                child: Semantics(
                  header: true,
                  child: Text(
                    kFindTitle,
                    style: AppTypography.header(
                      size: AppTypography.sizeXl,
                      weight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
              // Entry to the caller's own masked-résumé disclosure history.
              const DisclosureHistoryButton(),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s1,
            AppSpacing.gutter,
            0,
          ),
          child: FindViewSwitch(selected: _view, onChanged: _select),
        ),
        Expanded(
          child: IndexedStack(
            // Children are in [FindView] order.
            index: _view.index,
            sizing: StackFit.expand,
            children: <Widget>[
              if (_opened.contains(FindView.allCandidates))
                BlocProvider<CandidateSearchCubit>(
                  create: (_) => locator<CandidateSearchCubit>()..load(),
                  // #2592 — a return to the tab re-reads the view ON SCREEN
                  // quietly, keeping the pages already scrolled through.
                  child: BbTabRefreshListener(
                    enabled: _view == FindView.allCandidates,
                    onRefresh: (BuildContext context) =>
                        CandidateSearchView.refreshQuietly(context,
                            keepPages: true),
                    child: CandidateSearchView(onReveal: widget.onReveal),
                  ),
                )
              else
                const SizedBox.shrink(),
              if (_opened.contains(FindView.applicants))
                BlocProvider<FindCubit>(
                  // #2592 — a new Jobs card "Applicants" tap: a fresh feed, on
                  // the job that was tapped (#2593).
                  key: ValueKey<int>(widget.applicantsEpoch),
                  create: (_) =>
                      locator<FindCubit>()..load(jobId: widget.initialJobId),
                  child: BbTabRefreshListener(
                    enabled: _view == FindView.applicants,
                    onRefresh: _FindView.refreshQuietly,
                    child: _FindView(onReveal: widget.onReveal),
                  ),
                )
              else
                const SizedBox.shrink(),
            ],
          ),
        ),
      ],
    );
  }
}

class _FindView extends StatelessWidget {
  const _FindView({required this.onReveal});

  final ValueChanged<RevealArgs> onReveal;

  /// #2592 — the quiet re-read behind pull-to-refresh and a return to the
  /// tab: the rows stay on screen, and a failure says why in a toast.
  static Future<void> refreshQuietly(BuildContext context) =>
      refreshWithToast(context, context.read<FindCubit>().refresh);

  /// The credits-after preview for the unlock dialog. An error-state / unknown
  /// balance is `null` (rendered '—') — NEVER a fabricated 0 (#189 fast-follow).
  /// One derivation for every unlock path ([CreditsState.afterOneUnlock]).
  static int? _creditsAfter(CreditsState state) => state.afterOneUnlock;

  // --- MOCK unlock (int id, in-memory spend) --------------------------------
  Future<UnlockOutcome> _unlockCandidate(
    BuildContext context,
    Candidate candidate,
  ) async {
    final CreditsCubit credits = locator<CreditsCubit>();
    final bool? confirmed = await showUnlockDialog(
      context,
      shownName: NameMask.redacted(candidate.name),
      creditsAfter: _creditsAfter(credits.state),
    );
    if (confirmed != true || !context.mounted) return UnlockOutcome.cancelled;
    await credits.unlock(candidate.id);
    if (!context.mounted) return UnlockOutcome.granted;
    context.read<FindCubit>().markUnlocked(candidate.id);
    // #2596 — no "Unlocked!" toast: the reveal's one-shot stamp is the
    // confirmation, and a toast on top of it said the same thing twice.
    onReveal(RevealArgs.mock(
      candidate.copyWith(unlocked: true),
      justUnlocked: true,
    ));
    return UnlockOutcome.granted;
  }

  // --- REAL unlock (opaque worker UUID → POST /payer/unlocks) ----------------
  //
  // #2592 — [jobId] is the job of the feed the row was built from. A job switch
  // keeps the old rows tappable while the new ones load, and it can land while
  // the confirm dialog is open — the spend and the reveal stay on THIS job.
  /// #2593 — every outcome keeps the list on screen: an outage is a retry
  /// toast (it used to turn the whole feed into an error page), a deny the
  /// neutral toast. The outcome tells the card's [UnlockButton] to nudge.
  Future<UnlockOutcome> _unlockApplicant(
    BuildContext context,
    Applicant applicant, {
    required String? jobId,
  }) async {
    final FindCubit cubit = context.read<FindCubit>();
    final CreditsCubit credits = locator<CreditsCubit>();
    final bool? confirmed = await showUnlockDialog(
      context,
      shownName: applicant.maskedLabel,
      creditsAfter: _creditsAfter(credits.state),
    );
    if (confirmed != true || !context.mounted) return UnlockOutcome.cancelled;

    // #348 — the spend tap MUST NOT be able to end in silence. PayerHttp throws
    // on transport failure (its 15s timeout is designed to fire), and #346 now
    // makes a 5xx/429 throw too. Unguarded, both escaped as an unhandled async
    // exception out of this handler: the confirm dialog had already closed, so
    // the payer saw NOTHING — no toast, no reveal, no state change — could not
    // tell whether a credit had been spent, and tapped again, risking a
    // duplicate spend. An outage is retryable and must say so, which is also
    // distinct from the neutral deny below.
    final UnlockResult result;
    try {
      result = await cubit.unlockApplicant(applicant, jobId: jobId);
    } catch (_) {
      if (context.mounted) {
        showBbToast(
          context,
          title: 'Something went wrong',
          message: "Couldn't complete the unlock — please try again.",
          icon: Icons.refresh_rounded,
        );
      }
      return UnlockOutcome.failed;
    }

    if (!result.granted) {
      // Neutral deny — no credit / already / capped. Never a fabricated reason.
      if (context.mounted) {
        showBbToast(
          context,
          title: "Couldn't unlock",
          message: 'This candidate is not available to unlock right now.',
          icon: Icons.info_rounded,
        );
      }
      return UnlockOutcome.denied;
    }
    // Server-truth balance re-read after the grant.
    await credits.load();
    if (!context.mounted) return UnlockOutcome.granted;
    // #2596 — the reveal's stamp confirms the unlock; no duplicate toast.
    onReveal(RevealArgs.real(
      applicant: applicant.copyWith(unlocked: true, unlockId: result.unlockId),
      unlockId: result.unlockId!,
      jobId: jobId,
      justUnlocked: true,
    ));
    return UnlockOutcome.granted;
  }

  @override
  Widget build(BuildContext context) {
    // #2592 — a skeleton shaped like the feed while it loads; the real feed
    // cross-fades in over it.
    return BbLoadingBuilder<FindCubit, FindState>(
      isLoading: (FindState s) =>
          s.status == FindStatus.loading || s.status == FindStatus.initial,
      skeleton: const BbSkeletonList(
        header: BbSkeletonHeader(),
        row: BbSkeletonCandidateRow(),
        semanticLabel: 'Loading candidates',
      ),
      builder: (BuildContext context, FindState state) {
        if (state.status == FindStatus.error) {
          final PayerFailure failure =
              state.failure ?? const PayerFailure(PayerFailureKind.unknown);
          return BbStatusView(
            icon: failure.icon,
            title: failure.title,
            subtitle: failure.message,
            action: BbButton(
              label: failure.isSessionExpired ? 'Log in' : 'Retry',
              onPressed: () => context.read<FindCubit>().load(),
            ),
          );
        }
        if (state.status == FindStatus.empty) {
          // #2592 — pullable too: a payer whose first job just went live
          // pulls its applicants in without leaving the tab.
          return BbPullableFill(
            onRefresh: () => refreshQuietly(context),
            child: const BbStatusView(
              icon: Icons.work_rounded,
              title: 'No matched candidates yet',
              subtitle: 'Post a job to see matched candidates here.',
            ),
          );
        }

        final bool real = state.isRealFeed;
        final String role = real
            ? (state.selectedJob?.title ?? 'this role')
            : 'CNC Setter';
        final int count = real ? state.applicants.length : state.candidates.length;

        // #364 — the feed builds LAZILY. This was a plain `ListView(children:
        // [...])` that expanded EVERY applicant/candidate inline. Precisely
        // what that cost: SliverChildListDelegate does still inflate only the
        // elements near the viewport, so the cards were NOT all laid out — but
        // every one of them was CONSTRUCTED (each card widget plus its two
        // callback closures), here inside build(), and therefore again in full
        // on every FindCubit emission. A single unlock's re-emit rebuilt the
        // widget for all of the other rows. The applicant list is server-fed
        // and unbounded, so a posting with 150+ applicants pays that on each
        // emission, on the mid/low-end Android this market runs.
        // ListView.builder puts that construction behind the same laziness the
        // element inflation already had: each card is built only as it scrolls
        // into view (the header block is pinned above the list, #2593).
        //
        // When the REAL feed is empty the one "no applicants" row takes the
        // place of the card rows, so the row count is never 0 there.
        final int rowCount = real
            ? (state.applicants.isEmpty ? 1 : state.applicants.length)
            : state.candidates.length;

        // #2592 — a job switch keeps these rows on screen, dimmed under a thin
        // progress bar, until the new job's applicants replace them.
        final bool switching = state.switchingJobId != null;
        final Widget list = ListView.builder(
          // Over-scrolls even when short, so pull-to-refresh always works.
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            0,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          itemCount: rowCount,
          itemBuilder: (BuildContext context, int row) {
            if (real) {
              if (state.applicants.isEmpty) {
                return Padding(
                  padding: const EdgeInsets.only(top: AppSpacing.s6),
                  child: BbDim(
                    dimmed: switching,
                    child: Text(
                      'No applicants for this job yet.',
                      textAlign: TextAlign.center,
                      style: AppTypography.body(color: AppColors.textSecondary),
                    ),
                  ),
                );
              }
              final Applicant a = state.applicants[row];
              return Padding(
                // Keyed by worker, so a card's unlock lock never passes to
                // another row as the lazy list recycles.
                key: ValueKey<String>(a.workerId),
                padding: const EdgeInsets.only(bottom: AppSpacing.s3),
                child: BbDim(
                  dimmed: switching,
                  child: _ApplicantCard(
                    applicant: a,
                    unlocking: state.isUnlocking(a.workerId),
                    onUnlock: () => _unlockApplicant(context, a,
                        jobId: state.selectedJob?.id),
                    onView: () => onReveal(RevealArgs.real(
                      applicant: a,
                      unlockId: a.unlockId ?? '',
                      jobId: state.selectedJob?.id,
                    )),
                  ),
                ),
              );
            }
            final Candidate c = state.candidates[row];
            return Padding(
              key: ValueKey<int>(c.id),
              padding: const EdgeInsets.only(bottom: AppSpacing.s3),
              child: _CandidateCard(
                candidate: c,
                onUnlock: () => _unlockCandidate(context, c),
                onView: () =>
                    onReveal(RevealArgs.mock(c.copyWith(unlocked: true))),
              ),
            );
          },
        );

        // #2593 — the job, its selector and the count stay PINNED above the
        // list; they used to scroll away as its first row.
        return FindPinnedList(
          header: Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpacing.gutter,
              AppSpacing.s3,
              AppSpacing.gutter,
              AppSpacing.s3,
            ),
            child: _header(real: real, role: role, count: count, state: state),
          ),
          list: BbStaleFrame(
            busy: switching,
            child: BbRefreshIndicator(
              onRefresh: () => refreshQuietly(context),
              child: list,
            ),
          ),
        );
      },
    );
  }

  /// The PINNED block over the lazy feed (#364, #2593): the job it is for ·
  /// the job selector · the count line. No title — the page title sits above
  /// the view switch, once. Stretch cross-axis so the horizontal selector
  /// strip gets a bounded width.
  Widget _header({
    required bool real,
    required String role,
    required int count,
    required FindState state,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          'CANDIDATES FOR ${role.toUpperCase()}',
          style: AppTypography.eyebrow(color: AppColors.textMuted),
        ),
        // #358 — the search field and the "filter" chips that used to sit here
        // are GONE, not hidden. Neither was ever wired: the BbField had no
        // controller/onChanged so typing filtered nothing, and _staticFilters()
        // rendered hardcoded chips — 'Pune · 25 km' and 'Verified' shown as
        // SELECTED — over real applicants. That is a fabricated assertion about
        // people the payer is about to spend a credit to unlock: it claims the list
        // is radius-filtered and identity-verified when nothing of the sort ran.
        // A Delhi employer saw "Pune · 25 km". Same call the worker app already
        // made about its own decorative chips ("they could only ever have been
        // decorative"). Real filtering can come back when a real filter API does.
        const SizedBox(height: AppSpacing.s2),
        // The job selector is REAL (server-fed postings) and stays — but only
        // when there is a genuine choice to make.
        if (real && state.jobs.length > 1) ...<Widget>[
          _JobSelector(
            jobs: state.jobs,
            // #2592 — the chip just tapped reads as picked while it loads.
            selected: state.jobs
                    .where((JobPosting j) => j.id == state.switchingJobId)
                    .firstOrNull ??
                state.selectedJob,
          ),
          const SizedBox(height: AppSpacing.s2),
        ],
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
      ],
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
              icon: Icons.work_rounded,
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
///
/// #2593 — the all-candidates card's 360dp layout: a 40dp avatar, the facts
/// at full width, and the action in a full-width footer
/// ([CandidateCardAction]) instead of a column squeezed beside them.
class _ApplicantCard extends StatelessWidget {
  const _ApplicantCard({
    required this.applicant,
    required this.unlocking,
    required this.onUnlock,
    required this.onView,
  });

  final Applicant applicant;

  /// An unlock for him is in flight (the button shows progress).
  final bool unlocking;
  final Future<UnlockOutcome> Function() onUnlock;
  final VoidCallback onView;

  @override
  Widget build(BuildContext context) {
    final bool masked = !applicant.unlocked;

    // The shake is a failed unlock's nudge ([UnlockButton]); transform only.
    return BbShake(
      child: BbCard(
        // Kit: the 4px haldi left rail marks a HOT / featured card — earned,
        // never uniform. A green outline still marks an already-unlocked card.
        featured: applicant.hot,
        border:
            masked ? null : Border.all(color: AppColors.success, width: 1.5),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                const BbAvatar(
                  initials: '••',
                  size: CandidateCard.avatarSize,
                  mode: BbAvatarMode.masked,
                  sealed: true,
                ),
                const SizedBox(width: AppSpacing.s3),
                Expanded(child: _facts()),
              ],
            ),
            const SizedBox(height: AppSpacing.s3),
            // #2589 — credits only, never a ₹ price: the CTA reads "Unlock"
            // and the confirm dialog states the 1-credit spend.
            CandidateCardAction(
              unlocked: !masked,
              busy: unlocking,
              onUnlock: onUnlock,
              onView: onView,
            ),
          ],
        ),
      ),
    );
  }

  /// Everything the card says about him, beside the avatar.
  Widget _facts() {
    final List<String> signals = applicant.softSignals();
    // E18 — the match-tier chip. Null on legacy / non-V1 rows (no matchTier),
    // so those cards render exactly as before (soft signals + Hot only).
    final Widget? tierBadge = _tierBadge(applicant);
    return Column(
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
              const SizedBox(width: AppSpacing.gap6),
              const BbBadge(
                'Hot',
                tone: BbBadgeTone.danger,
                icon: Icons.local_fire_department_rounded,
                solid: true,
              ),
            ],
          ],
        ),
        const SizedBox(height: AppSpacing.gap3),
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
        if (tierBadge != null ||
            applicant.levelFit == 'not_confirmed' ||
            signals.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.gap6),
          Wrap(
            spacing: AppSpacing.gap6,
            runSpacing: AppSpacing.gap6,
            children: <Widget>[
              if (tierBadge != null) tierBadge,
              // #2548 — the ONLY level-fit tag shown. `meets` needs no
              // explanation, `below` stays quiet, and null/absent means
              // there is no level sort. The list order is the server's.
              if (applicant.levelFit == 'not_confirmed')
                const BbBadge(
                  'Level not confirmed',
                  tone: BbBadgeTone.warning,
                  icon: Icons.help_rounded,
                ),
              for (final String s in signals)
                BbBadge(s, tone: BbBadgeTone.neutral),
            ],
          ),
        ],
      ],
    );
  }

  /// E18 match-tier chip. When the applicant surfaced via a RELATED skill
  /// (tier 2), the payer opted into breadth and must see PLAINLY that this is a
  /// related-skill match — "Related to `skill`" — before spending a credit to unlock.
  /// A direct (tier 1) match gets a quiet positive affordance. Returns null on
  /// legacy / non-V1 rows (no [matchTier]) so those cards render exactly as
  /// before — no chip, no layout change.
  Widget? _tierBadge(Applicant a) {
    if (a.viaRelated && a.matchedSkillLabel != null) {
      return BbBadge(
        'Related to ${a.matchedSkillLabel}',
        tone: BbBadgeTone.warning,
        icon: Icons.hub_rounded,
      );
    }
    if (a.matchTier == 1) {
      return const BbBadge(
        'Direct match',
        tone: BbBadgeTone.success,
        icon: Icons.check_circle_rounded,
      );
    }
    return null;
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

/// The MOCK feed's card — the applicant card's twin in demo mode, on the same
/// 360dp layout (#2593): a 40dp avatar and a full-width footer action.
class _CandidateCard extends StatelessWidget {
  const _CandidateCard({
    required this.candidate,
    required this.onUnlock,
    required this.onView,
  });

  final Candidate candidate;
  final Future<UnlockOutcome> Function() onUnlock;
  final VoidCallback onView;

  @override
  Widget build(BuildContext context) {
    final bool masked = !candidate.unlocked;

    return BbShake(
      child: BbCard(
        // Kit: haldi left rail for a HOT candidate; green outline once
        // unlocked.
        featured: candidate.hot,
        border:
            masked ? null : Border.all(color: AppColors.success, width: 1.5),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: <Widget>[
                BbAvatar(
                  initials: masked ? '••' : NameMask.initials(candidate.name),
                  size: CandidateCard.avatarSize,
                  mode: masked ? BbAvatarMode.masked : BbAvatarMode.brand,
                  sealed: true,
                ),
                const SizedBox(width: AppSpacing.s3),
                Expanded(child: _facts(masked)),
              ],
            ),
            const SizedBox(height: AppSpacing.s3),
            CandidateCardAction(
              unlocked: !masked,
              onUnlock: onUnlock,
              onView: onView,
              viewIcon: Icons.phone_rounded,
            ),
          ],
        ),
      ),
    );
  }

  /// The name line, trade · skill, and the meta row, beside the avatar. The
  /// fit badge wraps with the meta: beside the facts it starved the name line
  /// at 360dp.
  Widget _facts(bool masked) {
    final String shownName = masked
        ? NameMask.redacted(candidate.name)
        : candidate.name;
    return Column(
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
            const SizedBox(width: AppSpacing.gap6),
            const Icon(Icons.verified_rounded, size: 15, color: AppColors.success),
            if (candidate.hot) ...<Widget>[
              const SizedBox(width: AppSpacing.gap6),
              const BbBadge(
                'Hot',
                tone: BbBadgeTone.danger,
                icon: Icons.local_fire_department_rounded,
                solid: true,
              ),
            ],
          ],
        ),
        const SizedBox(height: AppSpacing.gap3),
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
          runSpacing: AppSpacing.gap2,
          children: <Widget>[
            _meta(Icons.military_tech_rounded, candidate.exp),
            _meta(Icons.location_on_rounded, candidate.loc),
            _meta(
              Icons.circle_rounded,
              candidate.avail,
              color: AppColors.success,
              bold: true,
            ),
            if (candidate.fit.label != null)
              BbBadge(candidate.fit.label!, tone: BbBadgeTone.success),
          ],
        ),
      ],
    );
  }

  Widget _meta(IconData icon, String text, {Color? color, bool bold = false}) {
    final Color c = color ?? AppColors.textMuted;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(icon, size: color == AppColors.success ? 9 : 13, color: c),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              weight: bold ? FontWeight.w600 : FontWeight.w400,
              color: c,
            ),
          ),
        ),
      ],
    );
  }
}

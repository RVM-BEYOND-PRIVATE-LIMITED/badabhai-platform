import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../core/data/candidate_search_models.dart';
import '../../../core/data/models.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/payer_failure.dart';
import '../../../core/session/credits_cubit.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_badge.dart';
import '../../../core/widgets/bb_button.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_toast.dart';
import '../../../core/widgets/bb_unlock_dialog.dart';
import 'cubit/candidate_search_cubit.dart';
import 'disclosure_history_screen.dart';
import 'reveal_args.dart';
import 'widgets/candidate_card.dart';
import 'widgets/candidate_filter_sheet.dart';

// The copy below matches payer-web's Candidates tab word for word where the two
// surfaces say the same thing — one brand on the web and the phone.

/// The payer's hourly search cap (a 429) — neutral (no cause, no count), with
/// a Retry.
const String kSearchCappedTitle = 'Too many requests';
const String kSearchCappedMessage = 'Try again shortly.';

/// The calm note after a refused cursor restarted the list (never a Retry —
/// retrying would resend the cursor the server just refused).
const String kCursorRefusedMessage =
    "This page link isn't valid — showing the first page.";

/// The strict-mode note (ADR-0040 §4): strict never hides a not-recorded row.
const String kStrictNote = 'Only matches are shown.';
const String kStrictNoteWithUnrecorded = 'Only matches are shown, plus anyone '
    "whose profile doesn't record a detail you filtered on.";

/// Find's ALL-CANDIDATES view (ADR-0040, phase E2; owner rulings 2026-11-03):
/// every worker in the eligible pool, masked, ordered by the payer's filters —
/// company and agency sessions alike.
///
/// NEVER AN UNEXPLAINED EMPTY SCREEN (ADR-0040 Decision 3). The count badge
/// reads the SAME response as the rows (three numbers, never folded); filtered
/// results put a visible "Other candidates" line where the matches end; a
/// strict search that matches nobody keeps its counts and offers the way back;
/// an empty pool says so calmly.
///
/// Everything after the list is the per-job feed's flow, unchanged: the same
/// confirm dialog, the same 1-credit `POST /payer/unlocks` (with no job), and
/// the same reveal — the relay handle and the masked résumé, never a name or
/// phone.
class CandidateSearchView extends StatelessWidget {
  const CandidateSearchView({super.key, required this.onReveal});

  final ValueChanged<RevealArgs> onReveal;

  /// The reveal for a search row: no Applicant and no job — a search unlock
  /// has no posting context, so the masked résumé goes out with no posting id.
  static RevealArgs revealArgsFor(CandidateSearchRow row, String unlockId) =>
      RevealArgs.relay(
        workerId: row.workerId,
        unlockId: unlockId,
        title: row.maskedLabel,
        facets: <String>[
          row.role.label,
          candidateExperienceLine(row),
          if (row.city != null) row.city!,
        ],
      );

  @override
  Widget build(BuildContext context) {
    return BlocBuilder<CandidateSearchCubit, CandidateSearchState>(
      builder: (BuildContext context, CandidateSearchState state) {
        // `context` here is the view's own, stable while the tab is mounted —
        // the unlock handler awaits a dialog and a network call on it, so it
        // must not be a card's context that can scroll out of the list.
        return ListView.builder(
          padding: const EdgeInsets.fromLTRB(
            AppSpacing.gutter,
            AppSpacing.s2,
            AppSpacing.gutter,
            AppSpacing.s6,
          ),
          itemCount: _itemCount(state),
          itemBuilder: (BuildContext _, int index) =>
              _item(context, state, index),
        );
      },
    );
  }

  /// Header at index 0, then either ONE status block or the rows (+ the
  /// "Other candidates" line) and a footer. Lazy: a card is built only as it
  /// scrolls in (the #364 rule for an unbounded server-fed list).
  static int _itemCount(CandidateSearchState state) {
    if (state.status != CandidateSearchStatus.ready || state.rows.isEmpty) {
      return 2;
    }
    final int divider = state.otherCandidatesIndex >= 0 ? 1 : 0;
    return 1 + state.rows.length + divider + 1;
  }

  Widget _item(BuildContext context, CandidateSearchState state, int index) {
    if (index == 0) return _Header(state: state);
    switch (state.status) {
      case CandidateSearchStatus.initial:
      case CandidateSearchStatus.loading:
        return const Padding(
          padding: EdgeInsets.only(top: AppSpacing.s9),
          child: BbStatusView.loading(caption: 'Finding candidates…'),
        );
      case CandidateSearchStatus.error:
        return _ErrorBlock(state: state);
      case CandidateSearchStatus.empty:
        return const _EmptyPool();
      case CandidateSearchStatus.ready:
        break;
    }
    if (state.rows.isEmpty) return _NoMatches(state: state);

    int row = index - 1;
    final int divider = state.otherCandidatesIndex;
    if (divider >= 0) {
      if (row == divider) return const _OtherCandidatesLine();
      if (row > divider) row -= 1;
    }
    if (row >= state.rows.length) return _Footer(state: state);

    final CandidateSearchRow r = state.rows[row];
    final String? unlockId = state.unlockIdFor(r.workerId);
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.s3),
      child: CandidateCard(
        key: ValueKey<String>(r.workerId),
        row: r,
        unlocked: unlockId != null,
        unlocking: state.isUnlocking(r.workerId),
        relatedToLabel: state.pickedRoleLabel,
        onUnlock: () => _unlock(context, r),
        onView: () => onReveal(revealArgsFor(r, unlockId!)),
      ),
    );
  }

  /// The applicant card's unlock flow, unchanged in every step the payer sees:
  /// the same confirm dialog (1 credit · ₹40 · N left), the same three outcomes
  /// (#348 outage → retry toast · neutral deny · grant → balance re-read →
  /// reveal), and never a fabricated reason.
  Future<void> _unlock(BuildContext context, CandidateSearchRow row) async {
    final CandidateSearchCubit cubit = context.read<CandidateSearchCubit>();
    final CreditsCubit credits = locator<CreditsCubit>();
    final bool? confirmed = await showUnlockDialog(
      context,
      shownName: row.maskedLabel,
      creditsAfter: credits.state.afterOneUnlock,
    );
    if (confirmed != true || !context.mounted) return;

    final UnlockResult result;
    try {
      result = await cubit.unlock(row);
    } catch (_) {
      if (!context.mounted) return;
      showBbToast(
        context,
        title: 'Something went wrong',
        message: "Couldn't complete the unlock — please try again.",
        icon: Icons.refresh,
      );
      return;
    }
    if (!context.mounted) return;

    if (!result.granted) {
      showBbToast(
        context,
        title: "Couldn't unlock",
        message: 'This candidate is not available to unlock right now.',
        icon: Icons.info_outline,
      );
      return;
    }
    await credits.load();
    if (!context.mounted) return;
    showBbToast(
      context,
      title: 'Unlocked!',
      message: 'Contact via the in-app relay.',
    );
    onReveal(revealArgsFor(row, result.unlockId!));
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.state});

  final CandidateSearchState state;

  @override
  Widget build(BuildContext context) {
    final bool counts = state.status == CandidateSearchStatus.ready;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        Text(
          'ALL CANDIDATES',
          style: AppTypography.eyebrow(color: AppColors.textMuted),
        ),
        const SizedBox(height: AppSpacing.gap2),
        Row(
          children: <Widget>[
            Expanded(
              child: Text(
                'Browse & unlock',
                style: AppTypography.header(
                  size: AppTypography.sizeXl,
                  weight: FontWeight.w800,
                ),
              ),
            ),
            const DisclosureHistoryButton(),
          ],
        ),
        // An empty POOL has nothing to filter; every other state keeps the
        // filters in reach — a payer whose search failed can still change it.
        if (state.status != CandidateSearchStatus.empty) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          _FilterBar(state: state),
        ],
        if (state.notice == CandidateSearchNotice.cursorRefused) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          const _Notice(text: kCursorRefusedMessage),
        ],
        if (counts) ...<Widget>[
          const SizedBox(height: AppSpacing.s3),
          CandidateCountBadge(state: state),
        ],
        const SizedBox(height: AppSpacing.s3),
      ],
    );
  }
}

class _FilterBar extends StatelessWidget {
  const _FilterBar({required this.state});

  final CandidateSearchState state;

  Future<void> _open(BuildContext context) async {
    final CandidateSearchCubit cubit = context.read<CandidateSearchCubit>();
    final CandidateFilters? filters = state.filters;
    if (filters == null) {
      // The options are still loading, or failed: say which, and retry them.
      if (state.filtersFailed) cubit.reloadFilters();
      showBbToast(
        context,
        title: state.filtersFailed ? "Filters didn't load" : 'Loading filters…',
        message: state.filtersFailed
            ? 'Trying again — tap Filters in a moment.'
            : 'Tap Filters again in a moment.',
        icon: Icons.hourglass_bottom,
      );
      return;
    }
    final CandidateSearchQuery? next = await showCandidateFilterSheet(
      context,
      filters: filters,
      current: state.query,
    );
    if (next == null) return;
    await cubit.applyQuery(next);
  }

  @override
  Widget build(BuildContext context) {
    final CandidateSearchQuery q = state.query;
    final int n = q.filterCount;
    final String summary = _summary(q, state.filters);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        Wrap(
          spacing: AppSpacing.s2,
          runSpacing: AppSpacing.s2,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: <Widget>[
            BbButton(
              key: const Key('candidate_filters_open'),
              label: n == 0 ? 'Filters' : 'Filters · $n',
              variant: BbButtonVariant.secondary,
              size: BbButtonSize.md,
              iconLeft: Icons.tune,
              onPressed: () => _open(context),
            ),
            if (q.strict)
              const BbBadge(
                'Only matches',
                tone: BbBadgeTone.info,
                icon: Icons.filter_alt,
              ),
            if (q.hasFilters)
              BbButton(
                key: const Key('candidate_filters_clear'),
                label: 'Clear',
                variant: BbButtonVariant.ghost,
                size: BbButtonSize.sm,
                onPressed: () =>
                    context.read<CandidateSearchCubit>().clearFilters(),
              ),
          ],
        ),
        if (summary.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.gap6),
          Text(
            summary,
            style: AppTypography.body(
              size: AppTypography.sizeSm,
              color: AppColors.textMuted,
            ),
          ),
        ],
      ],
    );
  }

  /// "CNC Turner · 1–3 years in role · Pune" — the active filters in words.
  static String _summary(CandidateSearchQuery q, CandidateFilters? f) {
    String bucket(String id) => f?.bucketLabel(id) ?? id;
    return <String>[
      for (final String id in q.skillIds) f?.roleLabel(id) ?? id,
      if (q.experience != null) '${bucket(q.experience!)} in role',
      if (q.industryId != null) f?.industryLabel(q.industryId!) ?? q.industryId!,
      if (q.industryExperience != null)
        '${bucket(q.industryExperience!)} in industry',
      if (q.city != null) q.city!,
    ].join(' · ');
  }
}

/// The THREE counts, from the same response as the rows (ADR-0040 §1/§4),
/// never folded into one number:
///  - unfiltered: "62 candidates";
///  - filtered: "14 of 62 match", plus " · 9 not recorded" when some were kept
///    only because a filtered detail is unrecorded;
///  - strict: a note that only the matches are shown — plus the not-recorded
///    ones, which strict mode never excludes. (Reorder mode needs no note: the
///    "Other candidates" line marks where the matches end.)
class CandidateCountBadge extends StatelessWidget {
  const CandidateCountBadge({super.key, required this.state});

  final CandidateSearchState state;

  @override
  Widget build(BuildContext context) {
    final TextStyle base = AppTypography.body(
      size: AppTypography.sizeSm,
      color: AppColors.textMuted,
    );
    final TextStyle strong = AppTypography.body(
      size: AppTypography.sizeSm,
      weight: FontWeight.w700,
      color: AppColors.textPrimary,
    );
    final List<InlineSpan> spans = state.filtered
        ? <InlineSpan>[
            TextSpan(text: '${state.matched}', style: strong),
            const TextSpan(text: ' of '),
            TextSpan(text: '${state.total}', style: strong),
            const TextSpan(text: ' match'),
            if (state.unrecorded > 0) ...<InlineSpan>[
              const TextSpan(text: ' · '),
              TextSpan(text: '${state.unrecorded}', style: strong),
              const TextSpan(text: ' not recorded'),
            ],
          ]
        : <InlineSpan>[
            TextSpan(text: '${state.total}', style: strong),
            TextSpan(text: state.total == 1 ? ' candidate' : ' candidates'),
          ];
    final String? caption = !(state.filtered && state.strict)
        ? null
        : (state.unrecorded > 0 ? kStrictNoteWithUnrecorded : kStrictNote);
    return Column(
      key: const Key('candidate_count_badge'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        RichText(text: TextSpan(style: base, children: spans)),
        if (caption != null)
          Text(
            caption,
            style: AppTypography.body(
              size: AppTypography.sizeXs,
              color: AppColors.textMuted,
            ),
          ),
      ],
    );
  }
}

/// Where the matches end in reorder mode: everyone below misses a filter.
class _OtherCandidatesLine extends StatelessWidget {
  const _OtherCandidatesLine();

  @override
  Widget build(BuildContext context) {
    return Padding(
      key: const Key('other_candidates_line'),
      padding: const EdgeInsets.only(top: AppSpacing.s2, bottom: AppSpacing.s4),
      child: Semantics(
        header: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Row(
              children: <Widget>[
                Text(
                  'Other candidates',
                  style: AppTypography.heading(
                    size: AppTypography.sizeBase,
                    weight: FontWeight.w700,
                    color: AppColors.textSecondary,
                  ),
                ),
                const SizedBox(width: AppSpacing.s3),
                const Expanded(child: Divider(color: AppColors.border)),
              ],
            ),
            const SizedBox(height: AppSpacing.gap2),
            Text(
              "They don't match every filter you picked.",
              style: AppTypography.body(
                size: AppTypography.sizeXs,
                color: AppColors.textMuted,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Footer extends StatelessWidget {
  const _Footer({required this.state});

  final CandidateSearchState state;

  @override
  Widget build(BuildContext context) {
    final CandidateSearchCubit cubit = context.read<CandidateSearchCubit>();
    if (state.loadingMore) {
      return const Padding(
        padding: EdgeInsets.symmetric(vertical: AppSpacing.s4),
        child: Center(
          child: SizedBox(
            width: 28,
            height: 28,
            child: CircularProgressIndicator(
              strokeWidth: 3,
              color: AppColors.blue,
            ),
          ),
        ),
      );
    }
    final PayerFailure? failure = state.loadMoreFailure;
    if (failure != null) {
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.s2),
        child: Column(
          children: <Widget>[
            Text(
              failure.statusCode == 429 ? kSearchCappedMessage : failure.message,
              textAlign: TextAlign.center,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.textSecondary,
              ),
            ),
            const SizedBox(height: AppSpacing.s2),
            BbButton(
              key: const Key('candidate_load_more_retry'),
              label: 'Retry',
              variant: BbButtonVariant.secondary,
              size: BbButtonSize.md,
              iconLeft: Icons.refresh,
              onPressed: cubit.loadMore,
            ),
          ],
        ),
      );
    }
    if (state.nextCursor != null) {
      return Padding(
        padding: const EdgeInsets.only(top: AppSpacing.s1),
        child: BbButton(
          key: const Key('candidate_load_more'),
          label: 'Load more',
          variant: BbButtonVariant.secondary,
          size: BbButtonSize.md,
          iconLeft: Icons.expand_more,
          block: true,
          onPressed: cubit.loadMore,
        ),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.s4),
      child: Text(
        state.strict ? "That's every match." : "That's everyone for now.",
        textAlign: TextAlign.center,
        style: AppTypography.body(
          size: AppTypography.sizeSm,
          color: AppColors.textMuted,
        ),
      ),
    );
  }
}

/// A strict search that matches nobody (or, defensively, any page with no rows
/// while the pool is not empty): the counts stay in the header, and this says
/// what to do — never a bare empty screen.
class _NoMatches extends StatelessWidget {
  const _NoMatches({required this.state});

  final CandidateSearchState state;

  @override
  Widget build(BuildContext context) {
    final CandidateSearchCubit cubit = context.read<CandidateSearchCubit>();
    if (state.strict) {
      return BbStatusView(
        icon: Icons.filter_alt_off,
        title: 'No candidates match every filter',
        subtitle: '"Only show matches" hides everyone else — show all '
            'candidates to see them, with any matches first.',
        action: BbButton(
          key: const Key('candidate_drop_strict'),
          label: 'Show all candidates',
          onPressed: cubit.dropStrict,
        ),
      );
    }
    return BbStatusView(
      icon: Icons.filter_alt_off,
      title: 'No candidates match every filter',
      subtitle: 'Clear the filters to see everyone.',
      action: BbButton(
        label: 'Clear filters',
        onPressed: cubit.clearFilters,
      ),
    );
  }
}

/// `total == 0`: nobody in the pool yet. Calm — no blame, no zero shouted.
class _EmptyPool extends StatelessWidget {
  const _EmptyPool();

  @override
  Widget build(BuildContext context) {
    return BbStatusView(
      icon: Icons.groups,
      title: 'No candidates to show yet',
      subtitle: 'Workers appear here — faceless — once they are on BadaBhai '
          'and open to employers.',
      action: BbButton(
        label: 'Refresh',
        variant: BbButtonVariant.ghost,
        size: BbButtonSize.sm,
        onPressed: () => context.read<CandidateSearchCubit>().retry(),
      ),
    );
  }
}

class _ErrorBlock extends StatelessWidget {
  const _ErrorBlock({required this.state});

  final CandidateSearchState state;

  @override
  Widget build(BuildContext context) {
    final CandidateSearchCubit cubit = context.read<CandidateSearchCubit>();
    if (state.rateLimited) {
      return BbStatusView(
        icon: Icons.hourglass_bottom,
        title: kSearchCappedTitle,
        subtitle: kSearchCappedMessage,
        action: BbButton(label: 'Retry', onPressed: cubit.retry),
      );
    }
    final PayerFailure failure =
        state.failure ?? const PayerFailure(PayerFailureKind.unknown);
    // A 400 on a first page means the server refused the FILTERS themselves;
    // retrying sends the same body, so the way out is to clear them.
    final bool offerClear =
        failure.statusCode == 400 && state.query.hasFilters;
    return BbStatusView(
      icon: failure.icon,
      title: failure.title,
      subtitle: failure.message,
      action: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          BbButton(
            label: failure.isSessionExpired ? 'Log in' : 'Retry',
            onPressed: cubit.retry,
          ),
          if (offerClear) ...<Widget>[
            const SizedBox(height: AppSpacing.s2),
            BbButton(
              label: 'Clear filters',
              variant: BbButtonVariant.ghost,
              size: BbButtonSize.sm,
              onPressed: cubit.clearFilters,
            ),
          ],
        ],
      ),
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(AppSpacing.s3),
      decoration: BoxDecoration(
        color: AppColors.infoTint,
        borderRadius: BorderRadius.circular(AppRadii.sm),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          const Icon(Icons.info, size: 18, color: AppColors.teal700),
          const SizedBox(width: AppSpacing.s2),
          Expanded(
            child: Text(
              text,
              style: AppTypography.body(
                size: AppTypography.sizeSm,
                color: AppColors.teal700,
                height: 1.4,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

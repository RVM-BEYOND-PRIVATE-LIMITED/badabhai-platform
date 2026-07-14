import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart';
import '../../../core/di/locator.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/widgets/bb_bottom_sheet.dart';
import '../../../core/widgets/bb_job_card.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../router.dart';
import 'bloc/swipe_bloc.dart';
import 'bloc/swipe_state.dart';
import 'widgets/filters_sheet.dart';
import 'widgets/job_deck.dart';

/// The Jobs tab — the rich swipe-to-apply Feed (spec §5.5 / `.aw-feed`).
///
/// Header + filter chips + the [JobDeck] card deck + swipe hint. All business
/// logic stays in [SwipeBloc]; this widget renders state and dispatches events.
/// The real feed contract ([FeedItem] / getFeed) is PII-free and unchanged — the
/// rich card fields are MOCK-ONLY display data (see [_mockCardData]).
class SwipeJobsScreen extends StatelessWidget {
  const SwipeJobsScreen({super.key, this.bloc});

  /// Test seam: inject a [SwipeBloc] over a real repository + MockClient.
  final SwipeBloc? bloc;

  @override
  Widget build(BuildContext context) {
    final SwipeBloc? injected = bloc;
    if (injected != null) {
      return BlocProvider<SwipeBloc>.value(
        value: injected,
        child: const _FeedView(),
      );
    }
    return BlocProvider<SwipeBloc>(
      create: (_) => locator<SwipeBloc>(),
      child: const _FeedView(),
    );
  }
}

class _FeedView extends StatefulWidget {
  const _FeedView();

  @override
  State<_FeedView> createState() => _FeedViewState();
}

class _FeedViewState extends State<_FeedView> {
  // Filter chips are visual-only on the Feed (real filtering lives in the
  // Filters sheet, stage 4). CNC is pre-selected to match the spec.
  final Set<String> _chips = <String>{'CNC'};

  int _shownAppliedNonce = 0;
  int _shownPrioritizedNonce = 0;
  int _shownDecisionError = 0;

  /// The head jobId captured at skip-dispatch time. Skip success is silent in the
  /// bloc (it only advances the queue), so we confirm it here: once this id is no
  /// longer the head and no new decision error landed, we toast "Skipped".
  String? _pendingSkipId;

  /// The active filter selection. Drives the visible deck via
  /// [SwipeFiltersChanged] and seeds the sheet when it is reopened.
  FilterSelection _filters = FilterSelection.initial;

  @override
  void initState() {
    super.initState();
    context.read<SwipeBloc>().add(const SwipeFeedRequested());
  }

  void _toggleChip(String key) {
    setState(() => _chips.contains(key) ? _chips.remove(key) : _chips.add(key));
  }

  Future<void> _openFilters(BuildContext context) async {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    final FilterSelection? result = await showBbBottomSheet<FilterSelection>(
      context: context,
      // Pass the loaded queue so "Show N jobs" is the real filtered count.
      builder: (_) => FiltersSheet(initial: _filters, jobs: bloc.state.queue),
    );
    if (result != null && mounted) {
      setState(() => _filters = result);
      // Apply the selection to the visible deck (trade filter; client-side).
      bloc.add(SwipeFiltersChanged(result.trades));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        bottom: false,
        child: BlocConsumer<SwipeBloc, SwipeState>(
          listenWhen: (SwipeState prev, SwipeState curr) =>
              prev.decisionError != curr.decisionError ||
              prev.appliedNonce != curr.appliedNonce ||
              prev.prioritizedNonce != curr.prioritizedNonce ||
              prev.queue != curr.queue,
          listener: (BuildContext context, SwipeState state) {
            if (state.appliedNonce != _shownAppliedNonce) {
              _shownAppliedNonce = state.appliedNonce;
              _pendingSkipId = null;
              // Apply truly succeeded — confirm with a lightweight toast and let
              // the deck advance to the next card (no full-screen confirmation).
              _toast(context, 'Applied');
            } else if (state.prioritizedNonce != _shownPrioritizedNonce) {
              _shownPrioritizedNonce = state.prioritizedNonce;
              _pendingSkipId = null;
              // Up-swipe recorded the Priority intent (local for now) — confirm
              // with a toast; the deck has already advanced to the next card.
              _toast(context, 'Priority');
            } else if (state.decisionError != _shownDecisionError) {
              _shownDecisionError = state.decisionError;
              _pendingSkipId = null; // a failed skip never confirms
              _toast(context, 'Could not save. Please try again.');
            } else if (_pendingSkipId != null &&
                state.current?.jobId != _pendingSkipId) {
              // The skipped head advanced away with no error — confirm the skip.
              _pendingSkipId = null;
              _toast(context, 'Skipped');
            }
          },
          builder: (BuildContext context, SwipeState state) {
            return switch (state.status) {
              SwipeStatus.loading => const BbStatusView.loading(),
              SwipeStatus.error => _error(context, state),
              SwipeStatus.consentRequired => _consentRequired(context),
              SwipeStatus.empty => _empty(context),
              SwipeStatus.ready =>
                state.filteredOut ? _noMatch(context) : _feed(context, state),
            };
          },
        ),
      ),
    );
  }

  Widget _feed(BuildContext context, SwipeState state) {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    // Render the FILTERED deck — the head matches [SwipeState.current], the card
    // apply/skip act on, so the visible top card is always the decided one.
    final List<JobDeckItem> cards = state.visibleQueue
        .map((FeedItem i) => JobDeckItem(id: i.jobId, data: _mockCardData(i)))
        .toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _header(context),
        _chipRow(),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter, AppSpacing.s2, AppSpacing.gutter, 0),
            child: JobDeck(
              cards: cards,
              deciding: state.deciding,
              onTitleTap: (String id) async {
                // J3: applying from JobDetail pops back with 'applied' — surface
                // the same "Applied" toast here (no more Applied confirmation screen).
                final Object? result =
                    await context.push('${Routes.jobDetail}/$id');
                if (result == 'applied' && context.mounted) {
                  _toast(context, 'Applied');
                }
              },
              onSkip: () {
                // Capture the head id so the listener can confirm the skip once
                // it advances away with no error (the bloc has no skip nonce).
                _pendingSkipId = state.current?.jobId;
                bloc.add(const SwipeSkipped());
              },
              onApply: () => bloc.add(const SwipeApplied()),
              // Up-swipe = add to Priority (records intent locally + toasts;
              // no "priority jobs" screen yet — deferred with the backend).
              onPrioritize: () => bloc.add(const SwipePrioritized()),
            ),
          ),
        ),
        _swipeHint(),
      ],
    );
  }

  void _toast(BuildContext context, String message) {
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  Widget _header(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, AppSpacing.s3, AppSpacing.s3, AppSpacing.s3),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text('JOBS NEAR YOU', style: AppTypography.eyebrow()),
                const SizedBox(height: 2),
                Row(
                  children: <Widget>[
                    const Icon(Icons.place_outlined,
                        size: 20, color: AppColors.brand),
                    const SizedBox(width: AppSpacing.s1),
                    Text('Pune · 15 km',
                        style: AppTypography.display(
                            size: AppTypography.sizeMd,
                            weight: FontWeight.w800)),
                  ],
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Filter jobs',
            icon: const Icon(Icons.tune),
            onPressed: () => _openFilters(context),
          ),
        ],
      ),
    );
  }

  Widget _chipRow() {
    const List<(String, IconData)> chips = <(String, IconData)>[
      ('CNC', Icons.build_outlined),
      ('VMC', Icons.build_outlined),
      ('Verified', Icons.verified_user_outlined),
      ('Day shift', Icons.schedule),
    ];
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(
          AppSpacing.gutter, 0, AppSpacing.gutter, AppSpacing.s3),
      child: Row(
        children: <Widget>[
          for (final (String label, IconData icon) in chips) ...<Widget>[
            BbChip(
              label: label,
              icon: icon,
              selected: _chips.contains(label),
              onTap: () => _toggleChip(label),
            ),
            const SizedBox(width: AppSpacing.s2),
          ],
        ],
      ),
    );
  }

  Widget _swipeHint() {
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.s4),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: <Widget>[
          const Icon(Icons.swipe, size: 18, color: AppColors.textMuted),
          const SizedBox(width: AppSpacing.s2),
          Text('Skip · Apply',
              style: AppTypography.body(
                  size: AppTypography.sizeSm, color: AppColors.textMuted)),
        ],
      ),
    );
  }

  Widget _empty(BuildContext context) {
    return BbStatusView(
      icon: Icons.check_circle_outline_rounded,
      iconColor: AppColors.success,
      title: 'No more jobs right now.',
      subtitle: 'Check back later for new jobs.',
      action: FilledButton(
        onPressed: () =>
            context.read<SwipeBloc>().add(const SwipeFeedRequested()),
        child: const Text('Refresh'),
      ),
    );
  }

  /// Jobs exist but none match the active filter — distinct from the drained
  /// "No more jobs" state. Clearing the trade filter restores the full deck.
  Widget _noMatch(BuildContext context) {
    return BbStatusView(
      icon: Icons.filter_alt_off_outlined,
      iconColor: AppColors.brand,
      title: 'No jobs match your filters.',
      subtitle: 'Try removing a filter to see more jobs.',
      action: FilledButton(
        onPressed: () {
          setState(() => _filters = _filters.copyWith(trades: <String>{}));
          context.read<SwipeBloc>().add(SwipeFiltersChanged(const <String>{}));
        },
        child: const Text('Clear filters'),
      ),
    );
  }

  Widget _error(BuildContext context, SwipeState state) {
    return BbStatusView(
      icon: failureReason(state.failure).icon,
      title: 'Jobs load nahi hue.',
      subtitle: failureReason(state.failure).reason,
      action: FilledButton(
        onPressed: () =>
            context.read<SwipeBloc>().add(const SwipeFeedRequested()),
        child: const Text('Try again'),
      ),
    );
  }

  Widget _consentRequired(BuildContext context) {
    return BbStatusView(
      icon: Icons.privacy_tip_outlined,
      iconColor: AppColors.brand,
      title: 'Please accept consent to see jobs.',
      subtitle: 'It only takes a moment.',
      action: FilledButton(
        onPressed: () => context.go(Routes.consent),
        child: const Text('Go to consent'),
      ),
    );
  }
}

// MOCK-ONLY display fields (company name, pay band, spots-left, requirement
// tags, shift). The real worker-facing job contract is PII-sensitive — CLAUDE.md
// §2 lists employer names as PII — and exposing these on a LIVE endpoint needs an
// ADR ruling first. These values are fabricated client-side for the alpha and are
// NEVER sent to a real /feed, an event, ai_jobs, audit_logs, or a log. The real
// FeedItem/getFeed path stays PII-free and unchanged. These fields are NOT part
// of the FeedItem contract, so they are synthesised in this presentation mapper
// (not via the ApiClient/MockApiClient); serving them from a real endpoint is a
// §7 follow-up gated on the PII/ADR ruling.
BbJobCardData _mockCardData(FeedItem item) {
  const List<String> companies = <String>[
    'Sharma Precision Works',
    'Deccan Auto Components',
    'Kalyani Industries',
    'MIDC Engineering Co.',
  ];
  const List<String> bands = <String>['18–24k', '22–28k', '25–32k', '28–36k'];
  final int seed = item.jobId.hashCode & 0x7fffffff;
  return BbJobCardData(
    title: item.title,
    company: companies[seed % companies.length],
    payBand: bands[seed % bands.length],
    place: item.area == null ? item.city : '${item.area}, ${item.city}',
    shift: seed.isEven ? 'Day' : 'Rotational',
    tags: const <String>['Fanuc', '2+ yrs', 'PF + ESI'],
    spotsLeft: 1 + seed % 5,
  );
}

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
import '../domain/job_detail.dart';
import '../domain/job_filter.dart';
import 'bloc/swipe_bloc.dart';
import 'bloc/swipe_state.dart';
import 'widgets/filters_sheet.dart';
import 'widgets/job_deck.dart';

/// The Jobs tab — the rich swipe-to-apply Feed (spec §5.5 / `.aw-feed`).
///
/// Header + filter chips + the [JobDeck] card deck + swipe hint. All business
/// logic stays in [SwipeBloc]; this widget renders state and dispatches events.
/// The real feed contract ([FeedItem] / getFeed) is PII-free and unchanged — the
/// card shows ONLY real feed fields — no invented employer/pay (see [_cardData]).
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
  int _shownAppliedNonce = 0;
  int _shownDecisionError = 0;

  /// The head jobId captured at skip-dispatch time. Skip success is silent in the
  /// bloc (it only advances the queue), so we confirm it here: once this id is no
  /// longer the head and no new decision error landed, we toast "Skipped".
  String? _pendingSkipId;

  /// The ONE source of truth for filter state on this screen. BOTH the top chip
  /// row and the Filters sheet read and write it, and every write dispatches
  /// [SwipeFiltersChanged] — so a chip tap narrows the deck exactly like the
  /// sheet does. (The chips were previously visual-only, tracked in a separate
  /// set that nothing filtered on; that divergence was the bug.)
  FilterSelection _filters = FilterSelection.initial;

  @override
  void initState() {
    super.initState();
    context.read<SwipeBloc>().add(const SwipeFeedRequested());
  }

  /// The single write path for filter state: hold it locally (to seed the sheet
  /// and paint the chips) AND push it to the bloc (to narrow the deck). Takes the
  /// bloc rather than a [BuildContext] so callers can resolve it BEFORE an async
  /// gap (see [_openFilters]).
  void _setFilters(SwipeBloc bloc, FilterSelection next) {
    setState(() => _filters = next);
    bloc.add(SwipeFiltersChanged(next));
  }

  /// Toggle one trade from the top chip row — the same path the sheet takes.
  void _toggleTradeChip(BuildContext context, String trade) {
    final Set<String> trades = <String>{..._filters.trades};
    trades.contains(trade) ? trades.remove(trade) : trades.add(trade);
    _setFilters(context.read<SwipeBloc>(), _filters.copyWith(trades: trades));
  }

  Future<void> _openFilters(BuildContext context) async {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    final FilterSelection? result = await showBbBottomSheet<FilterSelection>(
      context: context,
      // Pass the loaded queue so "Show N jobs" is the real filtered count AND
      // the City options are derived from jobs that actually exist.
      builder: (_) => FiltersSheet(initial: _filters, jobs: bloc.state.queue),
    );
    if (result != null && mounted) {
      // Apply the whole selection (trade/city/experience) client-side. `bloc` was
      // resolved before the await, so nothing crosses the async gap.
      _setFilters(bloc, result);
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
              prev.queue != curr.queue,
          listener: (BuildContext context, SwipeState state) {
            if (state.appliedNonce != _shownAppliedNonce) {
              _shownAppliedNonce = state.appliedNonce;
              _pendingSkipId = null;
              // Apply truly succeeded — confirm with a lightweight toast and let
              // the deck advance to the next card (no full-screen confirmation).
              _toast(context, 'Applied');
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
        .map((FeedItem i) => JobDeckItem(id: i.jobId, data: _cardData(i)))
        .toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _header(context),
        _chipRow(context),
        Expanded(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
                AppSpacing.gutter, AppSpacing.s2, AppSpacing.gutter, 0),
            child: JobDeck(
              cards: cards,
              deciding: state.deciding,
              onTitleTap: (String id) async {
                // Hand the detail screen the REAL feed row — there is no
                // worker-facing job-detail route, so this row IS the source.
                final FeedItem item =
                    state.queue.firstWhere((FeedItem i) => i.jobId == id);
                // J3: applying from JobDetail pops back with 'applied' — surface
                // the same "Applied" toast here (no more Applied confirmation screen).
                final Object? result = await context.push(
                  '${Routes.jobDetail}/$id',
                  extra: JobDetail(
                    jobId: item.jobId,
                    title: item.title,
                    city: item.city,
                    area: item.area,
                  ),
                );
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
                // "JOBS FOR YOU", not "NEAR YOU": the feed applies NO location
                // filter (it is deliberately liberal), so "near" would be a
                // claim the backend does not make.
                Text('JOBS FOR YOU', style: AppTypography.eyebrow()),
                const SizedBox(height: 2),
                Row(
                  children: <Widget>[
                    const Icon(Icons.place_outlined,
                        size: 20, color: AppColors.brand),
                    const SizedBox(width: AppSpacing.s1),
                    Text(_cityLabel(),
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

  /// The header's location line, driven by the REAL city filter state — never a
  /// hardcoded place or distance. There is no distance/radius data anywhere in
  /// the stack, so a "· 15 km" claim would be a lie; the honest statement is
  /// simply which cities the deck is narrowed to.
  String _cityLabel() {
    final List<String> cities = _filters.cities.toList()..sort();
    return switch (cities.length) {
      0 => 'All cities',
      1 => cities.first,
      _ => '${cities.first} +${cities.length - 1}',
    };
  }

  /// The Feed's quick-filter row: REAL trade chips only. Each reads its selected
  /// state from [_filters] and writes through the same path as the sheet, so the
  /// two can never disagree.
  ///
  /// ("Verified" and "Day shift" chips used to sit here. Both are deleted: no
  /// backing field exists for either — verification is not on the `/feed` wire
  /// and shift is frozen mock-only display data per ADR-0024 — so they could
  /// only ever have been decorative.)
  Widget _chipRow(BuildContext context) {
    const List<(String, IconData)> chips = <(String, IconData)>[
      ('CNC', Icons.build_outlined),
      ('VMC', Icons.build_outlined),
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
              selected: _filters.trades.contains(label),
              onTap: () => _toggleTradeChip(context, label),
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
  /// "No more jobs" state. Clearing resets EVERY dimension (trade, city and
  /// experience) back to [FilterSelection.initial], so the full deck really does
  /// come back and the chips stop reading as selected. (It previously cleared
  /// only trades, leaving city/experience live and the chips visually stuck.)
  Widget _noMatch(BuildContext context) {
    return BbStatusView(
      icon: Icons.filter_alt_off_outlined,
      iconColor: AppColors.brand,
      title: 'No jobs match your filters.',
      subtitle: 'Try removing a filter to see more jobs.',
      action: FilledButton(
        onPressed: () =>
            _setFilters(context.read<SwipeBloc>(), FilterSelection.initial),
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

/// Maps a REAL [FeedItem] to the card. The feed carries ONLY title + place —
/// no employer name (PII per CLAUDE.md §2), no pay, no shift, no tags, no
/// spots-left — so none are set here. An earlier build invented all of them
/// client-side from `jobId.hashCode` and rendered them as fact.
BbJobCardData _cardData(FeedItem item) {
  return BbJobCardData(
    title: item.title,
    place: (item.area == null || item.area!.isEmpty)
        ? item.city
        : '${item.area}, ${item.city}',
  );
}

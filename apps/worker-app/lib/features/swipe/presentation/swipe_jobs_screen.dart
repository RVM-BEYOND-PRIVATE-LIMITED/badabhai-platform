import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart';
import '../../../core/di/locator.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/app_colors.dart';
import '../../../core/theme/app_spacing.dart';
import '../../../core/theme/app_typography.dart';
import '../../../core/util/job_display.dart';
import '../../../core/util/pay_format.dart';
import '../../../core/widgets/bb_alerts_action.dart';
import '../../../core/widgets/bb_bottom_sheet.dart';
import '../../../core/widgets/bb_job_card.dart';
import '../../../core/widgets/bb_chip.dart';
import '../../../core/widgets/bb_search_field.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_success_stamp.dart';
import '../../../router.dart';
import '../data/job_feed_view_store.dart';
import '../domain/job_detail.dart';
import '../domain/job_filter.dart';
import 'bloc/swipe_bloc.dart';
import 'bloc/swipe_state.dart';
import 'widgets/filters_sheet.dart';
import 'widgets/job_deck.dart';

/// Which [FilterSelection] dimension a [_FilterSuggestion] belongs to.
enum _FilterDim { trade, city, experience, shift, pay }

/// A unified filter-value suggestion or active pick surfaced by the header's
/// filter-search box — see `_FeedViewState._filterOptions`'s own doc for the
/// full shape/rationale.
@immutable
class _FilterSuggestion {
  const _FilterSuggestion({
    required this.dim,
    required this.value,
    required this.label,
  });

  final _FilterDim dim;
  final String value;
  final String label;
}

/// The Jobs tab — kit 07 "Job feed", switchable between TWO layouts via a
/// header toggle: a scrolling [ListView] of [BbJobCard]s (default — each with
/// an inline green "APPLY →" and a tappable title that opens the full posting)
/// and the original Tinder-style [JobDeck] (swipe right to apply, left to
/// skip). A deep-blue header ("Kaam milega." + the day's job count + a
/// filter-search box with a horizontal row of applied filter chips) sits
/// above the body in BOTH modes.
///
/// All business logic stays in [SwipeBloc]; this widget renders state and
/// dispatches events. The real feed contract ([FeedItem] / getFeed) is PII-free
/// and unchanged — the card shows ONLY real feed fields, no invented
/// employer/pay (see [_cardData]). List mode's inline apply dispatches
/// [SwipeCardApplied] (per-card, id-targeted); deck mode's swipe/buttons
/// dispatch [SwipeApplied] / [SwipeSkipped] (always the head card,
/// [SwipeState.current]). The title tap opens the detail route exactly the
/// same way in both modes (and prunes on an 'applied' pop, H-1).
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

  /// #1058 — briefly overlays the green success "stamp" when an apply truly
  /// lands. Non-blocking (behind an [IgnorePointer]) and self-clearing, so it
  /// celebrates the moment without trapping the worker on the feed.
  bool _applyStamp = false;
  Timer? _applyStampTimer;

  /// The header's unified filter-search box — types across every filter
  /// dimension (trade/city/experience/shift/pay); see [_filterOptions].
  final TextEditingController _filterSearchController = TextEditingController();
  String _filterQuery = '';

  @override
  void dispose() {
    _applyStampTimer?.cancel();
    _filterSearchController.dispose();
    super.dispose();
  }

  /// Flash the apply stamp for a beat, then remove it. A fresh [ValueKey] on the
  /// stamp (the applied nonce) remounts the one-shot animation on every apply.
  void _flashApplyStamp() {
    setState(() => _applyStamp = true);
    _applyStampTimer?.cancel();
    _applyStampTimer = Timer(const Duration(milliseconds: 1100), () {
      if (mounted) setState(() => _applyStamp = false);
    });
  }

  /// The ONE source of truth for filter state on this screen. BOTH the header
  /// chip row and the Filters sheet read and write it, and every write dispatches
  /// [SwipeFiltersChanged] — so a chip tap narrows the list exactly like the
  /// sheet does.
  FilterSelection _filters = FilterSelection.initial;

  /// Which body renders — the Tinder-style swipe deck (default) or the
  /// scrollable list. Starts at [JobFeedViewMode.deck] and stays there
  /// unless/until a persisted choice loads from [JobFeedViewStore] —
  /// eventual consistency, no flash-of-wrong-mode requirement, matching how
  /// [_filters] is seeded.
  JobFeedViewMode _viewMode = JobFeedViewMode.deck;

  @override
  void initState() {
    super.initState();
    context.read<SwipeBloc>().add(const SwipeFeedRequested());
    unawaited(_loadViewMode());
  }

  /// Reads the persisted view-mode preference if a store is registered — absent
  /// under the plugin-free widget-test graph, in which case the default
  /// [JobFeedViewMode.deck] simply stays. Fire-and-forget from [initState].
  Future<void> _loadViewMode() async {
    if (!locator.isRegistered<JobFeedViewStore>()) return;
    final JobFeedViewMode mode = await locator<JobFeedViewStore>().read();
    if (mounted && mode != _viewMode) setState(() => _viewMode = mode);
  }

  /// Flips the view mode, repaints, and persists the choice — fire-and-forget,
  /// never blocking the toggle tap on the write.
  void _toggleViewMode() {
    final JobFeedViewMode next = _viewMode == JobFeedViewMode.list
        ? JobFeedViewMode.deck
        : JobFeedViewMode.list;
    setState(() => _viewMode = next);
    if (locator.isRegistered<JobFeedViewStore>()) {
      unawaited(locator<JobFeedViewStore>().write(next));
    }
  }

  /// The single write path for filter state: hold it locally (to seed the sheet
  /// and paint the chips) AND push it to the bloc (to narrow the list). Takes the
  /// bloc rather than a [BuildContext] so callers can resolve it BEFORE an async
  /// gap (see [_openFilters]).
  void _setFilters(SwipeBloc bloc, FilterSelection next) {
    setState(() => _filters = next);
    bloc.add(SwipeFiltersChanged(next));
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

  /// Pull-to-refresh — reloads the feed via the SAME [SwipeFeedRequested] the
  /// empty-state "Refresh" button uses. `background: true` keeps the current list
  /// on screen (the RefreshIndicator supplies the spinner) instead of flashing
  /// the full-screen loader; the list updates reactively when the load lands. The
  /// short delay just gives the indicator a bounded, natural lifetime.
  Future<void> _onRefresh(BuildContext context) async {
    context.read<SwipeBloc>().add(const SwipeFeedRequested(background: true));
    await Future<void>.delayed(const Duration(milliseconds: 300));
  }

  @override
  Widget build(BuildContext context) {
    // The IndexedStack keeps this branch mounted, so initState's feed request
    // runs only on the first visit — refetch when the tab comes back into view
    // (T4). background: true keeps the current list on screen while it reloads.
    return TabFocusRefetch(
      tabFocus: locator<TabFocus>(),
      index: TabIndex.jobs,
      onFocused: () => context
          .read<SwipeBloc>()
          .add(const SwipeFeedRequested(background: true)),
      child: Scaffold(
        backgroundColor: AppColors.canvas,
        body: Stack(
          children: <Widget>[
            _body(context),
            // #1058 — the apply success stamp, centered and non-blocking. The
            // applied nonce keys it so each successful apply remounts the
            // one-shot animation.
            if (_applyStamp)
              Positioned.fill(
                child: IgnorePointer(
                  child: Center(
                    child: BbSuccessStamp(
                      key: ValueKey<int>(_shownAppliedNonce),
                      size: 64,
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    return BlocConsumer<SwipeBloc, SwipeState>(
      listenWhen: (SwipeState prev, SwipeState curr) =>
          prev.decisionError != curr.decisionError ||
          prev.appliedNonce != curr.appliedNonce,
      listener: (BuildContext context, SwipeState state) {
        if (state.appliedNonce != _shownAppliedNonce) {
          _shownAppliedNonce = state.appliedNonce;
          // Apply truly succeeded — confirm with a lightweight toast, flash
          // the success stamp, and let the list drop the applied card (no
          // full-screen confirmation).
          _toast(context, 'Applied');
          _flashApplyStamp();
        } else if (state.decisionError != _shownDecisionError) {
          _shownDecisionError = state.decisionError;
          _toast(context, 'Could not save. Please try again.');
        }
      },
      builder: (BuildContext context, SwipeState state) {
        return switch (state.status) {
          // Determinate progress is impossible for an open-ended fetch, so
          // the loader carries a caption — never a bare centered spinner.
          SwipeStatus.loading => const SafeArea(
              child: BbStatusView.loading(caption: 'Jobs load ho rahe hain…'),
            ),
          SwipeStatus.error => SafeArea(child: _error(context, state)),
          SwipeStatus.consentRequired =>
            SafeArea(child: _consentRequired(context)),
          SwipeStatus.empty => SafeArea(child: _empty(context)),
          SwipeStatus.ready => state.filteredOut
              ? SafeArea(child: _noMatch(context))
              : (_viewMode == JobFeedViewMode.list
                  ? _feed(context, state)
                  : _deck(context, state)),
        };
      },
    );
  }

  Widget _feed(BuildContext context, SwipeState state) {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    // Render the FILTERED list — the chip row + sheet narrow [visibleQueue].
    final List<FeedItem> jobs = state.visibleQueue;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _header(context, state),
        Expanded(
          child: RefreshIndicator(
            color: AppColors.blue,
            onRefresh: () => _onRefresh(context),
            child: ListView.builder(
              // AlwaysScrollable so a short list can still be pulled to refresh.
              physics: const AlwaysScrollableScrollPhysics(),
              // Clear the bottom gesture-nav inset so the last card isn't hidden.
              padding: EdgeInsets.only(
                  top: AppSpacing.s2,
                  bottom:
                      AppSpacing.s4 + MediaQuery.of(context).padding.bottom),
              itemCount: jobs.length,
              itemBuilder: (BuildContext context, int index) {
                final FeedItem item = jobs[index];
                return BbJobCard(
                  data: _cardData(item),
                  // The title opens the FULL posting (an accessible ≥48px button,
                  // #362); the green "APPLY →" applies to THIS job.
                  onTitleTap: () => _openDetail(context, bloc, item),
                  onApply: () => bloc.add(SwipeCardApplied(item.jobId)),
                );
              },
            ),
          ),
        ),
      ],
    );
  }

  /// The Tinder-style swipe deck (kit 07's original layout). Same header above
  /// it as [_feed] — only the body swaps. [JobDeck.cards] mirrors
  /// [SwipeState.visibleQueue] in the SAME order, so `cards.first` always
  /// matches [SwipeState.current] — the card apply/skip decides. [onApply] /
  /// [onSkip] fire once the front card commits and take no id, so they
  /// dispatch [SwipeApplied] / [SwipeSkipped] (which act on `state.current`),
  /// not the per-id [SwipeCardApplied] the list uses.
  Widget _deck(BuildContext context, SwipeState state) {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    final List<FeedItem> jobs = state.visibleQueue;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: <Widget>[
        _header(context, state),
        Expanded(
          child: Padding(
            // Horizontal: ZERO here — [BbJobCard]'s own built-in `s3` margin
            // is the ONLY horizontal inset, exactly like `_feed`'s ListView
            // (also zero of its own). Adding gutter here on top of the
            // card's own margin was stacking both, so a deck card rendered
            // narrower than the SAME card in list view.
            padding: EdgeInsets.fromLTRB(
              0,
              AppSpacing.s3,
              0,
              AppSpacing.s3 + MediaQuery.of(context).padding.bottom,
            ),
            child: JobDeck(
              cards: <JobDeckItem>[
                for (final FeedItem item in jobs)
                  JobDeckItem(id: item.jobId, data: _cardData(item)),
              ],
              deciding: state.deciding,
              onApply: () => bloc.add(const SwipeApplied()),
              onSkip: () => bloc.add(const SwipeSkipped()),
              onTitleTap: (String id) {
                final FeedItem item =
                    jobs.firstWhere((FeedItem job) => job.jobId == id);
                _openDetail(context, bloc, item);
              },
            ),
          ),
        ),
      ],
    );
  }

  /// Open the full posting for [item], handing over the light [JobDetail] the row
  /// already holds (there is no worker-facing job-detail route, so this row IS
  /// the source). If the detail applied OUTSIDE the list (its own cubit) it pops
  /// 'applied' — H-1: prune the job from the queue so it cannot linger and be
  /// skip-overwritten, and surface the same "Applied" toast.
  Future<void> _openDetail(
    BuildContext context,
    SwipeBloc bloc,
    FeedItem item,
  ) async {
    final Object? result = await context.push(
      '${Routes.jobDetail}/${item.jobId}',
      extra: JobDetail(
        jobId: item.jobId,
        title: item.title,
        city: item.city,
        area: item.area,
      ),
    );
    if (result == 'applied') {
      bloc.add(SwipeJobApplied(item.jobId));
      if (context.mounted) _toast(context, 'Applied');
    }
  }

  void _toast(BuildContext context, String message) {
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(message)));
  }

  /// The kit 07 deep-blue header: brand line + the day's job count + a horizontal
  /// filter-chip row, plus a "Filter jobs" affordance for the richer sheet
  /// (city / experience / shift / pay). The band bleeds under the status bar.
  Widget _header(BuildContext context, SwipeState state) {
    return Container(
      width: double.infinity,
      color: AppColors.blue,
      padding: EdgeInsets.fromLTRB(
        AppSpacing.gutter,
        MediaQuery.of(context).padding.top + AppSpacing.s3,
        AppSpacing.s3,
        AppSpacing.s3,
      ),
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
                    Text('Kaam milega.',
                        style: AppTypography.display(
                            size: AppTypography.sizeXl,
                            weight: FontWeight.w800,
                            color: AppColors.haldi)),
                    const SizedBox(height: AppSpacing.hairline),
                    Text('Aaj ${state.queue.length} naye jobs',
                        style: AppTypography.body(
                            size: AppTypography.size2xs,
                            color: AppColors.onBlueMuted)),
                  ],
                ),
              ),
              // Alerts moved off the bottom nav into a header bell (kit 4-tab
              // set) — surface it here so notifications stay reachable from the
              // feed, not only the Resume tab.
              const BbAlertsAction(color: AppColors.onBlue),
              // List <-> deck toggle. The icon shows the OTHER mode (a visual
              // hint of what tapping switches TO); the tooltip names the
              // CURRENT mode so a screen-reader worker isn't told to switch to
              // the mode they are already in.
              IconButton(
                key: const Key('jobFeedViewToggle'),
                tooltip: _viewMode == JobFeedViewMode.list
                    ? 'List view'
                    : 'Card view',
                icon: Icon(
                  _viewMode == JobFeedViewMode.list
                      ? Icons.style_outlined
                      : Icons.view_agenda_outlined,
                  color: AppColors.onBlue,
                ),
                onPressed: _toggleViewMode,
              ),
              IconButton(
                tooltip: 'Filter jobs',
                icon: Stack(
                  clipBehavior: Clip.none,
                  children: <Widget>[
                    const Icon(Icons.tune, color: AppColors.onBlue),
                    // "Filter active" dot. Visible whenever ANY filter is
                    // set — from the CNC/VMC chip row OR the Filters sheet, since
                    // both write the single [_filters] source of truth — and gone
                    // the moment every filter is cleared (`_filters.isEmpty`).
                    // Styled like the notification-count badge: crimson dot,
                    // white ring so it reads on the blue header.
                    Positioned(
                      top: -3,
                      right: -3,
                      child: Visibility(
                        visible: !_filters.isEmpty,
                        child: Container(
                          key: const Key('jobs_filter_active_dot'),
                          width: 13,
                          height: 13,
                          decoration: BoxDecoration(
                            color: AppColors.danger,
                            shape: BoxShape.circle,
                            // White ring so the dot reads on the blue header.
                            border: Border.all(
                              color: AppColors.onBlue,
                              width: 2,
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
                onPressed: () => _openFilters(context),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.s2),
          _searchBar(context),
          const SizedBox(height: AppSpacing.s2),
          _filterSearchArea(context, state),
        ],
      ),
    );
  }

  /// A tappable search pill on the blue band — opens the Indeed-style job search
  /// (title/skill + city). ADDITIVE to the existing filter affordance: the
  /// filter icon narrows the ALREADY-loaded feed, whereas this searches OPEN
  /// jobs by title + location server-side. A white paper pill so it reads as a
  /// real search box; a ≥48px hit target for a gloved thumb.
  Widget _searchBar(BuildContext context) {
    return Semantics(
      button: true,
      label: 'Job search kholein',
      child: Material(
        type: MaterialType.transparency,
        child: InkWell(
          key: const Key('feedSearchBar'),
          onTap: () => context.push(Routes.jobSearch),
          borderRadius: BorderRadius.circular(AppRadii.md),
          child: Container(
            height: AppSpacing.tap,
            padding: const EdgeInsets.symmetric(horizontal: AppSpacing.s3),
            decoration: BoxDecoration(
              color: AppColors.surfaceCard,
              borderRadius: BorderRadius.circular(AppRadii.md),
              border: Border.all(color: AppColors.borderSubtle),
            ),
            child: Row(
              children: <Widget>[
                const Icon(Icons.search, size: 20, color: AppColors.textMuted),
                const SizedBox(width: AppSpacing.s2),
                Expanded(
                  child: Text(
                    'Job title ya city se dhoondein',
                    overflow: TextOverflow.ellipsis,
                    style: AppTypography.body(
                      size: AppTypography.sizeSm,
                      color: AppColors.textSecondary,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  /// A unified filter-value suggestion or active pick: [dim] says which
  /// [FilterSelection] dimension it belongs to, [value] is the raw value that
  /// dimension stores (a trade label, a city name, an experience-band label,
  /// a shift WIRE value, or a pay-floor DISPLAY key — see [_filterOptions]),
  /// and [label] is what the worker actually reads.
  ///
  /// Presentation-only — this never crosses into `job_filter.dart`'s domain
  /// matching rules, it just labels the same values those rules already use.
  /// Prefixing every label with its dimension name ("Trade: CNC", "Shift:
  /// Night") disambiguates a mixed list where trade/city are self-evident but
  /// experience/shift/pay are not.
  static const Map<_FilterDim, String> _kDimPrefix = <_FilterDim, String>{
    _FilterDim.trade: 'Trade',
    _FilterDim.city: 'City',
    _FilterDim.experience: 'Experience',
    _FilterDim.shift: 'Shift',
    _FilterDim.pay: 'Pay',
  };

  /// Every value across all 5 [FilterSelection] dimensions the worker could
  /// search for — the universe [_matchingSuggestions] filters down as they
  /// type. Cities are DERIVED from the loaded queue (never hardcoded — see
  /// [availableCities]'s own doc on why); the other four dimensions are the
  /// same fixed vocabularies the "Filter jobs" sheet already offers.
  List<_FilterSuggestion> _filterOptions(SwipeState state) {
    return <_FilterSuggestion>[
      for (final String trade in kTradeFilterKeywords.keys)
        _FilterSuggestion(
            dim: _FilterDim.trade,
            value: trade,
            label: '${_kDimPrefix[_FilterDim.trade]}: $trade'),
      for (final String city
          in availableCities(state.queue, selected: _filters.cities))
        _FilterSuggestion(
            dim: _FilterDim.city,
            value: city,
            label: '${_kDimPrefix[_FilterDim.city]}: $city'),
      for (final String band in kExperienceBandLabels)
        _FilterSuggestion(
            dim: _FilterDim.experience,
            value: band,
            label: '${_kDimPrefix[_FilterDim.experience]}: $band'),
      for (final MapEntry<String, String> e in kShiftFilterLabels.entries)
        _FilterSuggestion(
            dim: _FilterDim.shift,
            value: e.value,
            label: '${_kDimPrefix[_FilterDim.shift]}: ${e.key}'),
      for (final String payLabel in kPayFloorOptions.keys)
        _FilterSuggestion(
            dim: _FilterDim.pay,
            value: payLabel,
            label: '${_kDimPrefix[_FilterDim.pay]}: $payLabel'),
    ];
  }

  /// True when [s] is already applied on [_filters] — excluded from
  /// suggestions (it already has a removable chip in the row below).
  bool _isFilterActive(_FilterSuggestion s) {
    switch (s.dim) {
      case _FilterDim.trade:
        return _filters.trades.contains(s.value);
      case _FilterDim.city:
        return _filters.cities.contains(s.value);
      case _FilterDim.experience:
        return _filters.experienceBands.contains(s.value);
      case _FilterDim.shift:
        return _filters.shift == s.value;
      case _FilterDim.pay:
        return _filters.payMin == kPayFloorOptions[s.value];
    }
  }

  /// Suggestions for the CURRENT [_filterQuery] — empty until the worker
  /// types something (a closed suggestion list with nothing typed would just
  /// dump the whole vocabulary on screen). Capped so a low-literacy worker
  /// never faces an overwhelming list.
  List<_FilterSuggestion> _matchingSuggestions(SwipeState state) {
    final String q = _filterQuery.trim().toLowerCase();
    if (q.isEmpty) return const <_FilterSuggestion>[];
    return _filterOptions(state)
        .where((_FilterSuggestion s) =>
            !_isFilterActive(s) && s.label.toLowerCase().contains(q))
        .take(8)
        .toList();
  }

  /// The currently-applied filters across every dimension, for the header's
  /// horizontal removable-chip row. Built straight from [_filters] (not from
  /// [_filterOptions]/the queue) so an active city whose jobs have all
  /// drained from the queue still keeps a chip to clear it with — the same
  /// reasoning `availableCities` documents for the sheet.
  List<_FilterSuggestion> _activeFilterChips() {
    final List<_FilterSuggestion> chips = <_FilterSuggestion>[
      for (final String t in _filters.trades)
        _FilterSuggestion(
            dim: _FilterDim.trade,
            value: t,
            label: '${_kDimPrefix[_FilterDim.trade]}: $t'),
      for (final String c in _filters.cities)
        _FilterSuggestion(
            dim: _FilterDim.city,
            value: c,
            label: '${_kDimPrefix[_FilterDim.city]}: $c'),
      for (final String b in _filters.experienceBands)
        _FilterSuggestion(
            dim: _FilterDim.experience,
            value: b,
            label: '${_kDimPrefix[_FilterDim.experience]}: $b'),
    ];
    final String? shift = _filters.shift;
    if (shift != null) {
      final String shiftLabel = kShiftFilterLabels.entries
          .firstWhere((MapEntry<String, String> e) => e.value == shift,
              orElse: () => MapEntry<String, String>(shift, shift))
          .key;
      chips.add(_FilterSuggestion(
          dim: _FilterDim.shift,
          value: shift,
          label: '${_kDimPrefix[_FilterDim.shift]}: $shiftLabel'));
    }
    final int? payMin = _filters.payMin;
    if (payMin != null) {
      final String payLabel = kPayFloorOptions.entries
          .firstWhere((MapEntry<String, int> e) => e.value == payMin,
              orElse: () => MapEntry<String, int>('₹$payMin+', payMin))
          .key;
      chips.add(_FilterSuggestion(
          dim: _FilterDim.pay,
          value: payLabel,
          label: '${_kDimPrefix[_FilterDim.pay]}: $payLabel'));
    }
    return chips;
  }

  /// Applies a tapped suggestion — trade/city/experience ADD to their set
  /// (multi-select dimensions); shift/pay REPLACE the single current value
  /// (single-select dimensions, same rule the sheet already follows). Clears
  /// the search query so the field is ready for the next filter.
  void _applyFilterSuggestion(BuildContext context, _FilterSuggestion s) {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    switch (s.dim) {
      case _FilterDim.trade:
        _setFilters(bloc,
            _filters.copyWith(trades: <String>{..._filters.trades, s.value}));
      case _FilterDim.city:
        _setFilters(bloc,
            _filters.copyWith(cities: <String>{..._filters.cities, s.value}));
      case _FilterDim.experience:
        _setFilters(
            bloc,
            _filters.copyWith(experienceBands: <String>{
              ..._filters.experienceBands,
              s.value
            }));
      case _FilterDim.shift:
        _setFilters(
            bloc,
            FilterSelection(
              trades: _filters.trades,
              cities: _filters.cities,
              experienceBands: _filters.experienceBands,
              shift: s.value,
              payMin: _filters.payMin,
            ));
      case _FilterDim.pay:
        _setFilters(
            bloc,
            FilterSelection(
              trades: _filters.trades,
              cities: _filters.cities,
              experienceBands: _filters.experienceBands,
              shift: _filters.shift,
              payMin: kPayFloorOptions[s.value],
            ));
    }
    _filterSearchController.clear();
    setState(() => _filterQuery = '');
  }

  /// Removes one already-applied filter from the header's chip row — the
  /// inverse of [_applyFilterSuggestion]. [FilterSelection.copyWith] cannot
  /// null out `shift`/`payMin` (by design — see its own doc), so those two
  /// branches rebuild the selection directly instead.
  void _removeFilterChip(BuildContext context, _FilterSuggestion s) {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    switch (s.dim) {
      case _FilterDim.trade:
        _setFilters(
            bloc,
            _filters.copyWith(
                trades: <String>{..._filters.trades}..remove(s.value)));
      case _FilterDim.city:
        _setFilters(
            bloc,
            _filters.copyWith(
                cities: <String>{..._filters.cities}..remove(s.value)));
      case _FilterDim.experience:
        _setFilters(
            bloc,
            _filters.copyWith(
                experienceBands: <String>{..._filters.experienceBands}
                  ..remove(s.value)));
      case _FilterDim.shift:
        _setFilters(
            bloc,
            FilterSelection(
              trades: _filters.trades,
              cities: _filters.cities,
              experienceBands: _filters.experienceBands,
              payMin: _filters.payMin,
            ));
      case _FilterDim.pay:
        _setFilters(
            bloc,
            FilterSelection(
              trades: _filters.trades,
              cities: _filters.cities,
              experienceBands: _filters.experienceBands,
              shift: _filters.shift,
            ));
    }
  }

  /// Replaces the old static CNC/VMC/"Sabhi" chip row: a search box over
  /// every filter dimension (trade/city/experience/shift/pay), suggestions
  /// appearing as the worker types, and a horizontal removable-chip row for
  /// whatever is currently applied. Writes through the SAME [_setFilters]
  /// path the "Filter jobs" sheet uses, so the filter-icon's active dot
  /// ([_filters.isEmpty]) and the sheet's own seeded selection can never
  /// disagree with a pick made here.
  ///
  /// ("Verified" and "Day shift" chips used to sit in the old row. Both were
  /// deleted when neither had a backing `/feed` field — Verification still
  /// has none, so it stays gone. Shift now has a real backing field and is
  /// reachable here, alongside every other dimension.)
  Widget _filterSearchArea(BuildContext context, SwipeState state) {
    final List<_FilterSuggestion> suggestions = _matchingSuggestions(state);
    final List<_FilterSuggestion> active = _activeFilterChips();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: <Widget>[
        BbSearchField(
          fieldKey: const Key('jobFilterSearchField'),
          controller: _filterSearchController,
          label: 'Filter search karein',
          hint: 'Trade, city, shift, pay dhoondein',
          onChanged: (String v) => setState(() => _filterQuery = v),
        ),
        if (suggestions.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          Container(
            decoration: BoxDecoration(
              color: AppColors.surfaceCard,
              borderRadius: BorderRadius.circular(AppRadii.md),
            ),
            padding: const EdgeInsets.all(AppSpacing.s2),
            child: Wrap(
              spacing: AppSpacing.s2,
              runSpacing: AppSpacing.s2,
              children: <Widget>[
                for (final _FilterSuggestion s in suggestions)
                  BbChip(
                    key: Key('jobFilterSuggestion_${s.dim.name}_${s.value}'),
                    label: s.label,
                    onTap: () => _applyFilterSuggestion(context, s),
                  ),
              ],
            ),
          ),
        ],
        if (active.isNotEmpty) ...<Widget>[
          const SizedBox(height: AppSpacing.s2),
          SizedBox(
            key: const Key('jobActiveFilterChips'),
            height: AppSpacing.tap,
            child: ListView.builder(
              scrollDirection: Axis.horizontal,
              itemCount: active.length,
              itemBuilder: (BuildContext context, int index) {
                final _FilterSuggestion s = active[index];
                final bool isLast = index == active.length - 1;
                return Padding(
                  padding: EdgeInsets.only(right: isLast ? 0 : AppSpacing.s2),
                  child: BbChip(
                    key: Key('jobFilterChip_${s.dim.name}_${s.value}'),
                    label: s.label,
                    selected: true,
                    icon: Icons.close,
                    onTap: () => _removeFilterChip(context, s),
                  ),
                );
              },
            ),
          ),
        ],
      ],
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
  /// experience) back to [FilterSelection.initial], so the full list really does
  /// come back and the chips stop reading as selected.
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

/// Maps a REAL [FeedItem] to the card. Per the ADR-0024 addendum (2026-07-16)
/// the feed now carries the REAL pay band + shift, so the card shows them when
/// present — a null field simply leaves its row hidden (never invented). Still
/// NEVER set here: company (employer identity is hidden entirely — nothing
/// employer-shaped, PII per CLAUDE.md §2), tags, spots-left, and `hot` (no real
/// "featured" source, so the haldi rail / HOT tag stay unearned). An earlier
/// build invented all of them client-side from `jobId.hashCode`.
///
/// The list card wires an inline "APPLY →", so its right-hand meta slot renders
/// the action rather than the shift; the shift still surfaces in full on the job
/// detail screen.
BbJobCardData _cardData(FeedItem item) {
  return BbJobCardData(
    title: item.title,
    place: (item.area == null || item.area!.isEmpty)
        ? item.city
        : '${item.area}, ${item.city}',
    payBand: formatPayBandCompact(item.payMin, item.payMax),
    shift: shiftLabel(item.shift),
    matchNote: matchNoteFor(item),
  );
}

/// E18 (ADR-0036) — the card's "why am I seeing this" line.
///
/// ONLY for a RELATED match, and only when the server named the skill. An exact
/// match needs no explanation; a related one does, because a job for a skill a
/// man never listed otherwise reads as a mistake. Both conditions are required:
/// with `via_related` true but no label we would have to write a vague "aapke
/// kaam se milta-julta" that explains nothing, so the card stays silent instead.
///
/// Aap-form, no exclamation, no emoji — the worker-facing persona rules. The
/// label is a closed-set value from the server, never free text.
String? matchNoteFor(FeedItem item) {
  if (!item.viaRelated) return null;
  final String? skill = item.matchedSkillLabel;
  if (skill == null || skill.trim().isEmpty) return null;
  return 'Aapke $skill ke kaam se milta-julta hai.';
}

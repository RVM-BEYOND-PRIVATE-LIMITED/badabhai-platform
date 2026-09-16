import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_bloc/flutter_bloc.dart';
import 'package:go_router/go_router.dart';

import '../../../core/api/api_models.dart';
import '../../../core/di/locator.dart';
import '../../../core/nav/tab_focus.dart';
import '../../../core/error/failure_reason.dart';
import '../../../core/theme/onboarding_theme.dart';
import '../../../core/util/job_display.dart';
import '../../../core/util/pay_format.dart';
import '../../../core/widgets/bb_alerts_action.dart';
import '../../../core/widgets/bb_bottom_sheet.dart';
import '../../../core/widgets/bb_job_card.dart';
import '../../../core/widgets/bb_status_view.dart';
import '../../../core/widgets/bb_success_stamp.dart';
import '../../../core/widgets/kit/kit_content_column.dart';
import '../../../core/widgets/kit/kit_header_actions.dart';
import '../../../core/widgets/kit/kit_tab_header.dart';
import '../../../router.dart';
import '../data/job_feed_view_store.dart';
import '../domain/job_detail.dart';
import '../domain/job_filter.dart';
import 'bloc/swipe_bloc.dart';
import 'bloc/swipe_state.dart';
import 'widgets/filters_sheet.dart';
import 'widgets/job_deck.dart';
import '../../../core/util/push_once.dart';

/// The Jobs tab (UI kit v3 §4 tab header + status strip), switchable between TWO
/// layouts via a strip toggle: a scrolling [ListView] of [BbJobCard]s (each with
/// an inline green "APPLY →" and a tappable title that opens the full posting)
/// and the Tinder-style [JobDeck] (swipe right to apply, left to skip, the
/// default).
///
/// The navy CHROME — header ("Kaam milega." + search, bell and Feedback) and the
/// status strip (the real count + the view toggle + "Filter jobs") — renders in
/// EVERY [SwipeStatus]; only the body below it swaps. It used to vanish in
/// loading / error / empty / no-match, so a worker whose filter matched nothing
/// could not see which filter was active, could not open the sheet and had no
/// bell.
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

  @override
  void dispose() {
    _applyStampTimer?.cancel();
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

  /// The ONE source of truth for filter state on this screen. BOTH the strip's
  /// chip row and the Filters sheet read and write it, and every write
  /// dispatches [SwipeFiltersChanged] — so removing a chip widens the list
  /// exactly like the sheet does.
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
      // Apply the whole selection (trade/city/experience/shift/pay)
      // client-side. `bloc` was resolved before the await, so nothing crosses
      // the async gap.
      _setFilters(bloc, result);
    }
  }

  /// Removes one already-applied filter from the strip's chip row.
  void _removeFilter(BuildContext context, JobFilterOption option) {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    _setFilters(bloc, withoutJobFilter(_filters, option));
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
      onFocused: () => context.read<SwipeBloc>().add(
        const SwipeFeedRequested(background: true),
      ),
      child: Scaffold(
        backgroundColor: OnboardingColors.canvasBg,
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
                      size: 44,
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
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: <Widget>[
            _header(context),
            _strip(context, state),
            _activeFilterRow(context),
            Expanded(child: _content(context, state)),
          ],
        );
      },
    );
  }

  /// The spec §4 navy tab header. The Jobs tab's own actions: job search, the
  /// alerts bell and Feedback (the yellow chat glyph means FEEDBACK in v3 — the
  /// Bada Bhai tab is where a worker talks to the bot).
  Widget _header(BuildContext context) {
    return KitTabHeader(
      title: 'Kaam milega.',
      actions: <Widget>[
        KitHeaderIconAction(
          key: const Key('feedSearchBar'),
          icon: Icons.search_rounded,
          // ADDITIVE to the filter: the filter narrows the ALREADY-loaded feed,
          // whereas this searches OPEN jobs by title + location server-side.
          tooltip: 'Job search kholein',
          onPressed: () => context.pushOnce(Routes.jobSearch),
        ),
        const BbAlertsAction(color: OnboardingColors.textOnBlue),
        const KitFeedbackAction(),
      ],
    );
  }

  /// The navy status strip under the header: the REAL visible count on the left,
  /// the view toggle and "Filter jobs" on the right.
  ///
  /// The count is [SwipeState.visibleQueue] — what is actually on screen — not
  /// the unfiltered queue, which disagreed with the narrowed list beneath it. It
  /// is HIDDEN while there is nothing loaded (loading, error, consent, drained,
  /// filtered-out): "0 naye jobs" is not a count, it is a claim about a queue
  /// nobody has seen yet.
  ///
  /// Vertical padding is 4, not the spec banner's 10: this strip carries two
  /// 48dp controls (the touch floor), and v10 around them would have made a
  /// 68dp band where the artboard has ~56.
  Widget _strip(BuildContext context, SwipeState state) {
    final int count = state.visibleQueue.length;
    return MediaQuery.withClampedTextScaling(
      maxScaleFactor: OnboardingLayout.chromeMaxTextScale,
      child: Container(
        width: double.infinity,
        color: OnboardingColors.shiftBlue,
        padding: const EdgeInsets.fromLTRB(16, 4, 3, 4),
        child: KitContentColumn(
          child: Row(
            children: <Widget>[
              Expanded(
                child: count == 0
                    ? const SizedBox.shrink()
                    : Text(
                        'Aaj $count naye jobs',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: OnboardingTypography.inter(
                          size: 13,
                          weight: FontWeight.w600,
                          color: OnboardingColors.textOnBlue,
                        ),
                      ),
              ),
              // The icon shows the OTHER mode (a visual hint of what tapping
              // switches TO); the tooltip names the CURRENT mode so a
              // screen-reader worker isn't told to switch to the mode they are
              // already in.
              KitHeaderIconAction(
                key: const Key('jobFeedViewToggle'),
                icon: _viewMode == JobFeedViewMode.list
                    ? Icons.style_outlined
                    : Icons.view_agenda_outlined,
                tooltip: _viewMode == JobFeedViewMode.list
                    ? 'List view'
                    : 'Card view',
                onPressed: _toggleViewMode,
              ),
              _FilterAction(
                active: !_filters.isEmpty,
                onPressed: () => _openFilters(context),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// The removable chips for whatever is currently applied — the one filter
  /// affordance that stays on the feed (the typed search and the option chips
  /// live in the sheet, which is what gave the deck its height back).
  ///
  /// A horizontal scroll view rather than a `ListView`: there are at most a
  /// handful of chips, and the feed's body already owns the screen's only list.
  Widget _activeFilterRow(BuildContext context) {
    final List<JobFilterOption> active = activeJobFilters(_filters);
    if (active.isEmpty) return const SizedBox.shrink();
    return Container(
      color: OnboardingColors.canvasBg,
      padding: const EdgeInsets.fromLTRB(14, 10, 14, 0),
      // minHeight, not a fixed height: the row must clear the 48dp touch floor
      // even when a chip is shorter than that, and must GROW rather than clip
      // when the worker's system font makes one taller.
      child: ConstrainedBox(
        key: const Key('jobActiveFilterChips'),
        constraints: const BoxConstraints(
          minHeight: OnboardingLayout.tapTarget,
        ),
        child: SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          child: Row(
            children: <Widget>[
              for (int i = 0; i < active.length; i++)
                Padding(
                  padding: EdgeInsets.only(
                    right: i == active.length - 1 ? 0 : 8,
                  ),
                  child: _ActiveFilterChip(
                    key: active[i].activeChipKey,
                    label: active[i].chipLabel,
                    onRemove: () => _removeFilter(context, active[i]),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _content(BuildContext context, SwipeState state) {
    return switch (state.status) {
      // Determinate progress is impossible for an open-ended fetch, so
      // the loader carries a caption — never a bare centered spinner.
      SwipeStatus.loading => const BbStatusView.loading(
        caption: 'Jobs load ho rahe hain…',
      ),
      SwipeStatus.error => _error(context, state),
      SwipeStatus.consentRequired => _consentRequired(context),
      SwipeStatus.empty => _empty(context),
      SwipeStatus.ready =>
        state.filteredOut
            ? _noMatch(context)
            : (_viewMode == JobFeedViewMode.list
                  ? _feed(context, state)
                  : _deck(context, state)),
    };
  }

  Widget _feed(BuildContext context, SwipeState state) {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    // Render the FILTERED list — the chip row + sheet narrow [visibleQueue].
    final List<FeedItem> jobs = state.visibleQueue;
    final double width = MediaQuery.sizeOf(context).width;

    return RefreshIndicator(
      color: OnboardingColors.shiftBlue,
      onRefresh: () => _onRefresh(context),
      child: ListView.builder(
        // AlwaysScrollable so a short list can still be pulled to refresh.
        physics: const AlwaysScrollableScrollPhysics(),
        // The card carries no side margin: this padding is the ONE horizontal
        // inset, and it grows on a tablet so the column stops at 600 while the
        // scrollbar stays at the screen edge. The bottom clears the gesture-nav
        // inset so the last card isn't hidden.
        padding: KitInsets.list(
          width,
          gutter: 14,
        ).copyWith(top: 14, bottom: 14 + MediaQuery.paddingOf(context).bottom),
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
    );
  }

  /// The Tinder-style swipe deck. [JobDeck.cards] mirrors
  /// [SwipeState.visibleQueue] in the SAME order, so `cards.first` always
  /// matches [SwipeState.current] — the card apply/skip decides. [onApply] /
  /// [onSkip] fire once the front card commits and take no id, so they
  /// dispatch [SwipeApplied] / [SwipeSkipped] (which act on `state.current`),
  /// not the per-id [SwipeCardApplied] the list uses.
  Widget _deck(BuildContext context, SwipeState state) {
    final SwipeBloc bloc = context.read<SwipeBloc>();
    final List<FeedItem> jobs = state.visibleQueue;

    return Padding(
      // Vertical only — [JobDeck] owns its own side gutter, so the card and the
      // CTA row beneath it share one inset source.
      padding: EdgeInsets.only(
        top: 14,
        bottom: 14 + MediaQuery.paddingOf(context).bottom,
      ),
      child: KitContentColumn(
        // A swipe card is a form-width object, not a list: 440 is where it
        // stops instead of stretching a single card across a tablet.
        maxWidth: OnboardingLayout.maxContentWidth,
        child: JobDeck(
          cards: <JobDeckItem>[
            for (final FeedItem item in jobs)
              JobDeckItem(id: item.jobId, data: _cardData(item)),
          ],
          deciding: state.deciding,
          onApply: () => bloc.add(const SwipeApplied()),
          onSkip: () => bloc.add(const SwipeSkipped()),
          onTitleTap: (String id) {
            final FeedItem item = jobs.firstWhere(
              (FeedItem job) => job.jobId == id,
            );
            _openDetail(context, bloc, item);
          },
        ),
      ),
    );
  }

  /// Open the full posting for [item], handing over the light [JobDetail] the row
  /// already holds. If the detail applied OUTSIDE the list (its own cubit) it pops
  /// 'applied' — H-1: prune the job from the queue so it cannot linger and be
  /// skip-overwritten, and surface the same "Applied" toast.
  Future<void> _openDetail(
    BuildContext context,
    SwipeBloc bloc,
    FeedItem item,
  ) async {
    final Object? result = await context.pushOnce(
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

  Widget _empty(BuildContext context) {
    // Hinglish, in the app's own aap-form voice — this was the one
    // English-only state on a Hinglish screen. And a NEUTRAL glyph: a
    // success-green tick told the worker that having no work to look at was
    // something that had gone right.
    return BbStatusView(
      icon: Icons.work_history_outlined,
      iconColor: OnboardingColors.shiftBlue,
      title: 'Abhi naye jobs nahi hain.',
      subtitle: 'Thodi der baad dobara dekhein.',
      action: FilledButton(
        onPressed: () =>
            context.read<SwipeBloc>().add(const SwipeFeedRequested()),
        child: const Text('Dobara dekhein'),
      ),
    );
  }

  /// Jobs exist but none match the active filter — distinct from the drained
  /// "No more jobs" state. Clearing resets EVERY dimension back to
  /// [FilterSelection.initial], so the full list really does come back and the
  /// chips stop reading as selected.
  Widget _noMatch(BuildContext context) {
    // Hinglish, for the same reason as [_empty] right above it: the two
    // empty states sit on one screen and cannot be in two languages.
    return BbStatusView(
      icon: Icons.filter_alt_off_outlined,
      iconColor: OnboardingColors.safetyYellow,
      title: 'Filter ke hisaab se koi job nahi mili.',
      subtitle: 'Ek filter hatakar dobara dekhein.',
      action: FilledButton(
        onPressed: () =>
            _setFilters(context.read<SwipeBloc>(), FilterSelection.initial),
        child: const Text('Filter hatayein'),
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
      iconColor: OnboardingColors.safetyYellow,
      title: 'Please accept consent to see jobs.',
      subtitle: 'It only takes a moment.',
      action: FilledButton(
        onPressed: () => context.go(Routes.consent),
        child: const Text('Go to consent'),
      ),
    );
  }
}

/// "Filter jobs" with the filter-active dot.
///
/// The dot is visible whenever ANY filter is set — from the chip row OR the
/// sheet, since both write the single [FilterSelection] source of truth — and
/// gone the moment every filter is cleared.
class _FilterAction extends StatelessWidget {
  const _FilterAction({required this.active, required this.onPressed});

  final bool active;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return IconButton(
      tooltip: 'Filter jobs',
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints.tightFor(
        width: OnboardingLayout.tapTarget,
        height: OnboardingLayout.tapTarget,
      ),
      onPressed: onPressed,
      icon: Stack(
        clipBehavior: Clip.none,
        children: <Widget>[
          const Icon(Icons.tune, size: 22, color: OnboardingColors.textOnBlue),
          Positioned(
            top: -2,
            right: -2,
            child: Visibility(
              visible: active,
              child: Container(
                key: const Key('jobs_filter_active_dot'),
                width: 8,
                height: 8,
                decoration: const BoxDecoration(
                  color: OnboardingColors.errorRed,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// An applied filter, as a chip that REMOVES itself on tap.
///
/// The v3 selected paint (navy fill, safety-yellow border, white label) with a
/// trailing `close_rounded` instead of the tick a [KitSelectChip] draws: this
/// chip's tap does not toggle a choice, it clears one, and a ✓ on a control
/// that removes something says the opposite of what happens.
class _ActiveFilterChip extends StatelessWidget {
  const _ActiveFilterChip({
    super.key,
    required this.label,
    required this.onRemove,
  });

  final String label;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final BorderRadius radius = BorderRadius.circular(OnboardingRadii.chip);
    return Semantics(
      button: true,
      selected: true,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onRemove,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: const BoxConstraints(
              minHeight: OnboardingLayout.tapTarget,
            ),
            child: Container(
              alignment: Alignment.center,
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              decoration: BoxDecoration(
                color: OnboardingColors.shiftBlue,
                borderRadius: radius,
                border: Border.all(
                  color: OnboardingColors.safetyYellow,
                  width: 1.5,
                ),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    label,
                    style: OnboardingTypography.inter(
                      size: 13,
                      weight: FontWeight.w600,
                      color: OnboardingColors.textOnBlue,
                    ),
                  ),
                  const SizedBox(width: 6),
                  const Icon(
                    Icons.close_rounded,
                    size: 14,
                    color: OnboardingColors.safetyYellow,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Maps a REAL [FeedItem] to the card. Per the ADR-0024 addendum (2026-07-16)
/// the feed now carries the REAL pay band + shift, so the card shows them when
/// present — a null field simply leaves its row hidden (never invented). Still
/// NEVER set here: company (employer identity is hidden entirely — nothing
/// employer-shaped, PII per CLAUDE.md §2), tags, spots-left, and `hot` (no real
/// "featured" source, so the yellow rail / HOT tag stay unearned). An earlier
/// build invented all of them client-side from `jobId.hashCode`.
///
/// The list card wires an inline "APPLY →", so its right-hand meta slot renders
/// the action rather than the shift; the shift still surfaces on the deck card
/// and in full on the job detail screen.
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

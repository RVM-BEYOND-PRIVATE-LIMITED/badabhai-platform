import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/error/failure.dart';
import '../../domain/job_detail.dart';
import '../../domain/job_filter.dart';
import '../../domain/swipe_repository.dart';
import 'swipe_state.dart';

// ---------------- Events ----------------

sealed class SwipeEvent extends Equatable {
  const SwipeEvent();

  @override
  List<Object?> get props => <Object?>[];
}

/// (Re)load the feed.
class SwipeFeedRequested extends SwipeEvent {
  const SwipeFeedRequested({
    this.background = false,
    this.fresh = false,
    this.done,
  });

  /// A silent tab-focus refetch (T4) rather than the screen's first load.
  ///
  /// Background refetches do NOT emit `loading` and do NOT wipe the deck on
  /// failure: the worker is looking at real jobs, and a blip must not replace
  /// them with a spinner or an error view. A stale deck beats no deck.
  final bool background;

  /// The feed must reflect the server AS OF NOW — the worker's match inputs
  /// just changed ([JobFeedInvalidation]). A load already in flight may have
  /// been answered before that write landed, so instead of being dropped by
  /// the in-flight guard this request runs once more after it.
  final bool fresh;

  /// Completed when the load that serves this request settles (success or
  /// failure). Lets a pull-to-refresh / refresh button spin for the REAL
  /// load instead of a fixed delay. Not part of equality.
  final Completer<void>? done;

  @override
  List<Object?> get props => <Object?>[background, fresh];
}

/// Append the NEXT page of the deck (#2068, ADR-0052) — the Jobs tab asks for
/// this as the worker nears the end of what is loaded, and the bloc asks itself
/// when decisions drain the deck that far (see [SwipeBloc._advance]).
///
/// A no-op unless [SwipeState.nextCursor] holds a cursor: null means the deck is
/// finished for this scroll (end of deck, an API build without the key, or a
/// cursor dropped by a filter change), and page 1 is then the only legal call.
/// Firing it repeatedly is safe — the in-flight guard collapses the extras.
class SwipeNextPageRequested extends SwipeEvent {
  const SwipeNextPageRequested();
}

/// Apply to the current (head) card.
class SwipeApplied extends SwipeEvent {
  const SwipeApplied();
}

/// Skip the current (head) card.
class SwipeSkipped extends SwipeEvent {
  const SwipeSkipped();
}

/// Apply to a SPECIFIC job from the vertical feed LIST (kit 07 Job feed). The
/// old swipe deck could only ever decide the HEAD card, so [SwipeApplied]
/// targets [SwipeState.current]; the list shows every job at once and each card
/// has its own inline "APPLY →", so this carries the tapped job's id and applies
/// to it directly. Identical repository call + advance / decision-error
/// bookkeeping as [SwipeApplied] (success bumps `appliedNonce` → the feed's
/// "Applied" toast; failure bumps `decisionError`). A no-op when the id is no
/// longer in the queue (already decided / filtered away) or a decision is
/// already in flight.
class SwipeCardApplied extends SwipeEvent {
  const SwipeCardApplied(this.jobId);

  final String jobId;

  @override
  List<Object?> get props => <Object?>[jobId];
}

/// A job was applied OUTSIDE the deck — the JobDetail full-screen applies via
/// its own [JobDetailCubit] and pops back with `'applied'`; the Feed dispatches
/// this so the just-applied job is PRUNED from the queue (H-1). Without it the
/// card stayed deck head after the pop, and the natural next gesture — a left
/// swipe — POSTed a skip whose server upsert (last-write-wins, ADR-0009 §2)
/// silently flipped the fresh applied row to skipped.
class SwipeJobApplied extends SwipeEvent {
  const SwipeJobApplied(this.jobId);

  final String jobId;

  @override
  List<Object?> get props => <Object?>[jobId];
}


/// The worker changed the filters — from the "Filter jobs" sheet OR the Feed's
/// top chip row, which both dispatch this one event. [filters] is the whole
/// selection across Trade/City/Experience ([FilterSelection.initial] = show
/// all). Recomputes the visible deck client-side over the already-loaded queue
/// — no refetch — and DROPS the paging cursor (#2068).
class SwipeFiltersChanged extends SwipeEvent {
  const SwipeFiltersChanged(this.filters);

  final FilterSelection filters;

  @override
  List<Object?> get props => <Object?>[filters];
}

// ---------------- Bloc ----------------

class SwipeBloc extends Bloc<SwipeEvent, SwipeState> {
  SwipeBloc(this._repo) : super(const SwipeState()) {
    on<SwipeFeedRequested>(_onFeedRequested);
    on<SwipeNextPageRequested>(_onNextPageRequested);
    on<SwipeApplied>(_onApplied);
    on<SwipeCardApplied>(_onCardApplied);
    on<SwipeSkipped>(_onSkipped);
    on<SwipeJobApplied>(_onJobApplied);
    on<SwipeFiltersChanged>(_onFiltersChanged);
  }

  final SwipeRepository _repo;

  /// How few UNDECIDED cards may be left before the next page is fetched
  /// (#2068). Deck mode shows one card at a time and list mode two or three, so
  /// a handful of cards is far enough ahead for the page to land before the
  /// worker reaches the bottom, and small enough that a worker who never scrolls
  /// costs the server one page.
  static const int prefetchThreshold = 5;

  /// The FULL posting for one job, delegated to the feed repository so a card
  /// can be enriched through the SAME client/session (and the same test mock).
  /// Exposed as a method, not an event: it never mutates feed state, and the
  /// screen owns the per-card detail cache. A failure propagates as a
  /// [Failure]; the caller treats it as "no extra facts".
  Future<JobDetail> jobDetail(String jobId) => _repo.jobDetail(jobId);

  /// True while a feed load is in flight. The tab-focus refetch and the screen's
  /// own initState load can both fire around a first visit, and bloc 8.x runs
  /// handlers concurrently by default — two overlapping loads would double the
  /// network work and race their emits.
  bool _loadingFeed = false;

  /// A [SwipeFeedRequested.fresh] request arrived while a load was in flight:
  /// run one more background load once it settles.
  bool _reloadQueued = false;

  /// True while a NEXT-PAGE load is in flight (#2068). Separate from
  /// [_loadingFeed] because the two loads are different animals — page 1
  /// replaces the deck, a cursor page appends to it — and the near-the-end
  /// trigger fires once per built card, so without this guard one scroll would
  /// send the same cursor several times over.
  bool _loadingPage = false;

  /// [SwipeFeedRequested.done] completers waiting on the load in flight (or
  /// the queued one). Completed — never errored — when that load settles.
  final List<Completer<void>> _waiters = <Completer<void>>[];

  Future<void> _onFeedRequested(
    SwipeFeedRequested event,
    Emitter<SwipeState> emit,
  ) async {
    final Completer<void>? done = event.done;
    if (done != null) _waiters.add(done);
    if (_loadingFeed) {
      if (event.fresh) _reloadQueued = true;
      return;
    }
    _loadingFeed = true;
    try {
      bool background = event.background;
      do {
        _reloadQueued = false;
        final List<Completer<void>> served = List<Completer<void>>.of(_waiters);
        _waiters.clear();
        try {
          await _loadFeed(emit, background: background);
        } finally {
          // Even an unexpected (non-Failure) throw settles its waiters — a
          // refresh spinner must never outlive the load it was waiting on.
          _complete(served);
        }
        // A queued re-run never flashes the loader over a deck just loaded.
        background = true;
      } while (_reloadQueued && !emit.isDone);
    } finally {
      _loadingFeed = false;
      _reloadQueued = false;
      _complete(_waiters);
      _waiters.clear();
    }
  }

  static void _complete(List<Completer<void>> waiters) {
    for (final Completer<void> waiter in waiters) {
      if (!waiter.isCompleted) waiter.complete();
    }
  }

  @override
  Future<void> close() {
    _complete(_waiters);
    _waiters.clear();
    return super.close();
  }

  /// One `GET /feed` round-trip, for PAGE 1 or for the page after [cursor]
  /// (#2068). The narrowing params are identical either way, which is the
  /// contract: a cursor is a position in ONE order under ONE set of filters, so
  /// the filters may not move during a scroll — [_onFiltersChanged] drops the
  /// cursor rather than letting that happen.
  ///
  /// `trade_key` is the one param resolved from the loaded QUEUE, so a cursor
  /// page could in principle resolve it differently from page 1 (a page-2 card
  /// can be the sibling slug that makes a family chip ambiguous). That only ever
  /// widens the server-side read — the deck is still narrowed client-side by
  /// [applyJobFilters] — so it can add inventory, never admit a job the filter
  /// excludes.
  Future<FeedPage> _fetchFeed({String? cursor}) {
    // Resolve a one-trade filter back to a REAL slug from the loaded queue
    // (#1906) — sending the chip LABEL as `trade_key` never matched a slug and
    // zeroed the deck. Null means "don't narrow server-side"; the client-side
    // match still narrows the full feed.
    final String? trade = outboundTradeKey(state.filters, state.queue);
    final String? city =
        state.filters.cities.length == 1 ? state.filters.cities.first : null;
    // Shift + pay floor are single-value, so they thread straight through as the
    // OUTBOUND `/feed` narrowing params (server-side); the client-side match in
    // [applyJobFilters] is what narrows the already-loaded deck immediately.
    return _repo.getFeed(
      tradeKey: trade,
      city: city,
      shift: state.filters.shift,
      payMin: state.filters.payMin,
      cursor: cursor,
    );
  }

  /// PAGE 1 and its emits — no cursor, so the queue is REPLACED, which is what
  /// every caller of [SwipeFeedRequested] means: the screen's first load, the
  /// tab-focus and resume refetches, the match-input invalidation, the header
  /// refresh and pull-to-refresh. [background] keeps the current deck on screen
  /// while it reloads.
  ///
  /// The response's own cursor replaces whatever we held: a page-1 read starts a
  /// NEW scroll, so the old position is void and `next_cursor: null` (an older
  /// API build, a rollback, or a deck that fits in one page) must land as null.
  Future<void> _loadFeed(
    Emitter<SwipeState> emit, {
    required bool background,
  }) async {
    if (!background) {
      emit(state.copyWith(status: SwipeStatus.loading));
    }
    try {
      final FeedPage page = await _fetchFeed();
      final List<FeedItem> jobs = page.jobs;
      emit(state.copyWith(
        queue: jobs,
        status: jobs.isEmpty ? SwipeStatus.empty : SwipeStatus.ready,
        nextCursor: page.nextCursor,
      ));
    } on Failure catch (failure) {
      // 403 routes to consent; everything else (network / unknown / 401 / 5xx)
      // is the generic error view.
      final bool isConsent = failure is ConsentRequiredFailure;
      // A background refetch must not replace a readable deck with an error.
      // Consent is the exception: a 403 means the worker genuinely cannot see
      // jobs any more, so it routes even from a background refetch.
      final bool keepCurrent = background &&
          !isConsent &&
          state.status == SwipeStatus.ready;
      if (!keepCurrent) {
        emit(state.copyWith(
          status: isConsent ? SwipeStatus.consentRequired : SwipeStatus.error,
          // Only the error view surfaces the honest reason; consent routes to its
          // own view, so keep its state shape unchanged.
          failure: isConsent ? null : failure,
        ));
      }
    }
  }

  /// The page AFTER the loaded queue (#2068, ADR-0052). APPENDS — the worker
  /// keeps the cards (and the place) he already has.
  ///
  /// Never shows a loader and never shows an error view: this load is entirely
  /// behind the worker's back, and a deck of real jobs must not be replaced by
  /// either because card 51 did not arrive. A plain failure keeps the queue AND
  /// the cursor, so the next trigger re-sends the SAME cursor — safe, because
  /// the read is idempotent (it re-emits `feed.shown` for the cards it serves,
  /// as a refetch does today).
  Future<void> _onNextPageRequested(
    SwipeNextPageRequested event,
    Emitter<SwipeState> emit,
  ) async {
    final String? cursor = state.nextCursor;
    if (cursor == null || _loadingPage) return;
    _loadingPage = true;
    try {
      final FeedPage page = await _fetchFeed(cursor: cursor);
      // The scroll moved on while we were out — a page-1 load landed, or the
      // filters changed — so this page answers a position nobody is at any
      // more. Appending it would splice old cards into a new deck.
      if (emit.isDone || state.nextCursor != cursor) return;
      final List<FeedItem> merged = _appendDeduped(state.queue, page.jobs);
      emit(state.copyWith(
        queue: merged,
        status: merged.isEmpty ? SwipeStatus.empty : SwipeStatus.ready,
        nextCursor: page.nextCursor,
      ));
    } on FeedCursorRejectedFailure {
      // The server refused the cursor: malformed, or minted for a feed order a
      // flag flip replaced (ADR-0052 §2.2). Drop it FIRST so the dead value can
      // never go back on the wire, then refetch page 1 — silently, in the
      // background, no error state. Skipped only when a page-1 load is already
      // in flight: it is about to replace the deck and its cursor anyway.
      if (emit.isDone) return;
      emit(state.copyWith(nextCursor: null));
      if (!_loadingFeed) await _loadFeed(emit, background: true);
    } on Failure {
      // Keep the deck and the cursor (see the method doc): the worker is looking
      // at real jobs, and the same cursor is safe to resend.
    } finally {
      _loadingPage = false;
    }
  }

  /// [incoming] appended to [loaded], skipping any card already in the deck.
  ///
  /// Required by the V1 path (ADR-0052 §3.3): a card whose paid boost expired
  /// between two pages sorts into the unboosted bucket and is re-served once.
  /// Without this the worker would see — and could apply to — the same job
  /// twice, and the duplicate would break `_advance`'s remove-by-id.
  static List<FeedItem> _appendDeduped(
    List<FeedItem> loaded,
    List<FeedItem> incoming,
  ) {
    final Set<String> seen =
        loaded.map((FeedItem job) => job.jobId).toSet();
    return <FeedItem>[
      ...loaded,
      for (final FeedItem job in incoming)
        if (seen.add(job.jobId)) job,
    ];
  }

  /// Ask for the next page once the UNDECIDED deck is down to
  /// [prefetchThreshold] cards. Called after every advance, so deck mode — where
  /// the worker never scrolls, he decides — pages without the screen having to
  /// watch anything. List mode adds its own near-the-end trigger for the worker
  /// who scrolls past cards without deciding.
  ///
  /// Counts the WHOLE [SwipeState.queue] rather than `visibleQueue`, which is
  /// the conservative direction: with a filter on, the undecided deck is never
  /// longer than what the worker can see, so this pages no EARLIER than a
  /// visible count would. The list view's own trigger, which counts the cards it
  /// actually renders, covers a filtered deck emptying faster than the queue.
  void _maybeRequestNextPage() {
    if (!state.hasMorePages || _loadingPage) return;
    if (state.queue.length > prefetchThreshold) return;
    add(const SwipeNextPageRequested());
  }

  Future<void> _onApplied(SwipeApplied event, Emitter<SwipeState> emit) async {
    final FeedItem? job = state.current;
    if (job == null || state.deciding) return;
    emit(state.copyWith(deciding: true));
    try {
      await _repo.applyToJob(job.jobId, rank: job.rank);
      _advance(emit, job, applied: true);
    } on Failure catch (failure) {
      _onDecisionError(emit, failure);
    }
  }

  /// Apply to a specific job by id (the vertical feed list's inline "APPLY →").
  /// Mirrors [_onApplied] but looks the job up in the queue instead of taking
  /// the head, so any visible card can be applied to. The job is captured before
  /// the `await` and handed to [_advance], so a filter change landing mid-flight
  /// cannot make it drop the wrong card (same discipline as [_onApplied]).
  Future<void> _onCardApplied(
    SwipeCardApplied event,
    Emitter<SwipeState> emit,
  ) async {
    if (state.deciding) return;
    final int index =
        state.queue.indexWhere((FeedItem job) => job.jobId == event.jobId);
    if (index < 0) return; // already decided / filtered away
    final FeedItem job = state.queue[index];
    emit(state.copyWith(deciding: true));
    try {
      await _repo.applyToJob(job.jobId, rank: job.rank);
      _advance(emit, job, applied: true);
    } on Failure catch (failure) {
      _onDecisionError(emit, failure);
    }
  }

  Future<void> _onSkipped(SwipeSkipped event, Emitter<SwipeState> emit) async {
    final FeedItem? job = state.current;
    if (job == null || state.deciding) return;
    emit(state.copyWith(deciding: true));
    try {
      // A single-tap skip means "not interested"; richer reasons are a later
      // refinement. Still a coarse, PII-free enum.
      await _repo.skipJob(job.jobId, reason: 'not_interested');
      _advance(emit, job);
    } on Failure catch (failure) {
      _onDecisionError(emit, failure);
    }
  }

  /// Prune a job the DETAIL screen already applied to (server-confirmed — the
  /// detail pops `'applied'` only after its POST succeeded). Mirrors [_advance]
  /// minus the decision bookkeeping: no network call happened HERE, `deciding`
  /// is untouched, and `appliedNonce` is NOT bumped (the Feed toasts off the
  /// pop result — bumping would double-toast). Removing by id keeps this safe
  /// against filter changes landing mid-flight, same as [_advance].
  void _onJobApplied(SwipeJobApplied event, Emitter<SwipeState> emit) {
    final List<FeedItem> next = state.queue
        .where((FeedItem job) => job.jobId != event.jobId)
        .toList();
    if (next.length == state.queue.length) return; // not in the deck
    emit(state.copyWith(
      queue: next,
      status: next.isEmpty ? SwipeStatus.empty : SwipeStatus.ready,
    ));
    _maybeRequestNextPage();
  }

  /// Recompute the visible deck for a new filter selection. Pure client-side over
  /// the loaded queue (no refetch, no `/feed` filter contract). Keeps the queue
  /// and all decision state intact — only what is VISIBLE changes.
  ///
  /// The one thing it DOES throw away is the paging cursor (#2068, ADR-0052): the
  /// cursor is a keyset position inside the order the OLD filters produced, so
  /// sending it with new ones asks the server a question about a deck that no
  /// longer exists. Null means the next `/feed` call is page 1, under the new
  /// filters — the refetch the ADR requires — and until one happens the worker
  /// keeps seeing the loaded deck, narrowed instantly client-side exactly as
  /// before.
  Future<void> _onFiltersChanged(
    SwipeFiltersChanged event,
    Emitter<SwipeState> emit,
  ) async {
    emit(state.copyWith(filters: event.filters, nextCursor: null));
  }

  /// Drop the DECIDED card by id, not by position — with a filter active the
  /// visible head is not necessarily `queue.first`. `status` tracks the undecided
  /// queue draining; a non-empty queue whose remainder is all filtered out stays
  /// `ready` and renders the "no jobs match" state.
  /// [applied] bumps `appliedNonce` (apply toast) — only on real success.
  ///
  /// [decided] is passed in by the caller, captured BEFORE its `await`, and is
  /// deliberately NOT re-read from `state.current` here. Bloc runs the handlers
  /// for different event types CONCURRENTLY, so a [SwipeFiltersChanged] landing
  /// mid-decision (the chip row is live while a card is in flight) would move
  /// `state.current` to a different job — and re-reading it would drop THAT card
  /// instead: the decided job would survive in the queue and reappear, while an
  /// untouched job vanished unseen. Advancing on the captured id keeps the card
  /// we actually decided the card we actually remove.
  void _advance(
    Emitter<SwipeState> emit,
    FeedItem decided, {
    bool applied = false,
  }) {
    final List<FeedItem> next = state.queue
        .where((FeedItem job) => job.jobId != decided.jobId)
        .toList();
    emit(state.copyWith(
      queue: next,
      deciding: false,
      status: next.isEmpty ? SwipeStatus.empty : SwipeStatus.ready,
      appliedNonce: applied ? state.appliedNonce + 1 : state.appliedNonce,
    ));
    // The deck just got shorter — top it up if it is running out (#2068).
    _maybeRequestNextPage();
  }

  /// Apply/skip failed. Keep the current card (the worker does not lose their
  /// place); a 403 routes to consent, anything else bumps the snackbar nonce.
  void _onDecisionError(Emitter<SwipeState> emit, Failure failure) {
    if (failure is ConsentRequiredFailure) {
      emit(state.copyWith(deciding: false, status: SwipeStatus.consentRequired));
    } else if (failure is UnauthorizedFailure) {
      // Mirror the load path: a missing/invalid token is a full-screen error,
      // not a transient snackbar. Currently unreachable (the session token is
      // never cleared once set), but kept in parity with _onFeedRequested.
      emit(state.copyWith(
          deciding: false, status: SwipeStatus.error, failure: failure));
    } else {
      emit(state.copyWith(
        deciding: false,
        decisionError: state.decisionError + 1,
      ));
    }
  }
}

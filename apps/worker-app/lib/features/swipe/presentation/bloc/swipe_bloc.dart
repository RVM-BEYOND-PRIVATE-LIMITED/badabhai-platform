import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/error/failure.dart';
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
  const SwipeFeedRequested({this.background = false});

  /// A silent tab-focus refetch (T4) rather than the screen's first load.
  ///
  /// Background refetches do NOT emit `loading` and do NOT wipe the deck on
  /// failure: the worker is looking at real jobs, and a blip must not replace
  /// them with a spinner or an error view. A stale deck beats no deck.
  final bool background;

  @override
  List<Object?> get props => <Object?>[background];
}

/// Apply to the current (head) card.
class SwipeApplied extends SwipeEvent {
  const SwipeApplied();
}

/// Skip the current (head) card.
class SwipeSkipped extends SwipeEvent {
  const SwipeSkipped();
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
/// — no refetch.
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
    on<SwipeApplied>(_onApplied);
    on<SwipeSkipped>(_onSkipped);
    on<SwipeJobApplied>(_onJobApplied);
    on<SwipeFiltersChanged>(_onFiltersChanged);
  }

  final SwipeRepository _repo;

  /// True while a feed load is in flight. The tab-focus refetch and the screen's
  /// own initState load can both fire around a first visit, and bloc 8.x runs
  /// handlers concurrently by default — two overlapping loads would double the
  /// network work and race their emits.
  bool _loadingFeed = false;

  Future<void> _onFeedRequested(
    SwipeFeedRequested event,
    Emitter<SwipeState> emit,
  ) async {
    if (_loadingFeed) return;
    _loadingFeed = true;
    // A background refetch keeps the current deck on screen while it reloads.
    if (!event.background) {
      emit(state.copyWith(status: SwipeStatus.loading));
    }
    try {
      final List<FeedItem> jobs = await _repo.getFeed();
      emit(state.copyWith(
        queue: jobs,
        status: jobs.isEmpty ? SwipeStatus.empty : SwipeStatus.ready,
      ));
    } on Failure catch (failure) {
      // 403 routes to consent; everything else (network / unknown / 401 / 5xx)
      // is the generic error view.
      final bool isConsent = failure is ConsentRequiredFailure;
      // A background refetch must not replace a readable deck with an error.
      // Consent is the exception: a 403 means the worker genuinely cannot see
      // jobs any more, so it routes even from a background refetch.
      final bool keepCurrent = event.background &&
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
    } finally {
      _loadingFeed = false;
    }
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
  }

  /// Recompute the visible deck for a new filter selection. Pure client-side over
  /// the loaded queue (no refetch, no `/feed` filter contract). Keeps the queue
  /// and all decision state intact — only what is VISIBLE changes.
  Future<void> _onFiltersChanged(
    SwipeFiltersChanged event,
    Emitter<SwipeState> emit,
  ) async {
    emit(state.copyWith(filters: event.filters));
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

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/error/failure.dart';
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
  const SwipeFeedRequested();
}

/// Apply to the current (head) card.
class SwipeApplied extends SwipeEvent {
  const SwipeApplied();
}

/// Skip the current (head) card.
class SwipeSkipped extends SwipeEvent {
  const SwipeSkipped();
}

/// Add the current (head) card to Priority (up-swipe). Flutter-only for now.
class SwipePrioritized extends SwipeEvent {
  const SwipePrioritized();
}

// ---------------- Bloc ----------------

class SwipeBloc extends Bloc<SwipeEvent, SwipeState> {
  SwipeBloc(this._repo) : super(const SwipeState()) {
    on<SwipeFeedRequested>(_onFeedRequested);
    on<SwipeApplied>(_onApplied);
    on<SwipeSkipped>(_onSkipped);
    on<SwipePrioritized>(_onPrioritized);
  }

  final SwipeRepository _repo;

  Future<void> _onFeedRequested(
    SwipeFeedRequested event,
    Emitter<SwipeState> emit,
  ) async {
    emit(state.copyWith(status: SwipeStatus.loading));
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
      emit(state.copyWith(
        status: isConsent ? SwipeStatus.consentRequired : SwipeStatus.error,
        // Only the error view surfaces the honest reason; consent routes to its
        // own view, so keep its state shape unchanged.
        failure: isConsent ? null : failure,
      ));
    }
  }

  Future<void> _onApplied(SwipeApplied event, Emitter<SwipeState> emit) async {
    final FeedItem? job = state.current;
    if (job == null || state.deciding) return;
    emit(state.copyWith(deciding: true));
    try {
      await _repo.applyToJob(job.jobId, rank: job.rank);
      _advance(emit, applied: true);
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
      _advance(emit);
    } on Failure catch (failure) {
      _onDecisionError(emit, failure);
    }
  }

  Future<void> _onPrioritized(
    SwipePrioritized event,
    Emitter<SwipeState> emit,
  ) async {
    final FeedItem? job = state.current;
    if (job == null || state.deciding) return;
    emit(state.copyWith(deciding: true));
    try {
      // Flutter-only seam for now (the prioritize backend is being built
      // separately). Records the intent and advances — NOT marked applied.
      await _repo.prioritizeJob(job.jobId);
      _advance(emit, prioritized: true);
    } on Failure catch (failure) {
      _onDecisionError(emit, failure);
    }
  }

  /// Drop the head card; show the empty state when the queue drains. [applied]
  /// bumps `appliedNonce` (apply toast); [prioritized] bumps `prioritizedNonce`
  /// (Priority toast) — both only on real success.
  void _advance(
    Emitter<SwipeState> emit, {
    bool applied = false,
    bool prioritized = false,
  }) {
    final List<FeedItem> next = state.queue.sublist(1);
    emit(state.copyWith(
      queue: next,
      deciding: false,
      status: next.isEmpty ? SwipeStatus.empty : SwipeStatus.ready,
      appliedNonce: applied ? state.appliedNonce + 1 : state.appliedNonce,
      prioritizedNonce:
          prioritized ? state.prioritizedNonce + 1 : state.prioritizedNonce,
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

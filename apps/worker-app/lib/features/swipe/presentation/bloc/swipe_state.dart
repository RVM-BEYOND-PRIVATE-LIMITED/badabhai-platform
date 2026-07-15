import 'package:equatable/equatable.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/error/failure.dart';
import '../../domain/job_filter.dart';

enum SwipeStatus { loading, ready, empty, error, consentRequired }

class SwipeState extends Equatable {
  const SwipeState({
    this.status = SwipeStatus.loading,
    this.queue = const <FeedItem>[],
    this.filters = FilterSelection.initial,
    this.deciding = false,
    this.decisionError = 0,
    this.appliedNonce = 0,
    this.prioritizedNonce = 0,
    this.failure,
  });

  final SwipeStatus status;

  /// The typed cause when [status] is `error` — the error view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  /// ALL remaining undecided cards (unfiltered). A failed apply/skip leaves the
  /// decided card untouched so nothing is lost on a network drop.
  final List<FeedItem> queue;

  /// The active filter selection — Trade, City and Experience (from the "Filter
  /// jobs" sheet AND the Feed's top chip row, which share this one source of
  /// truth). [FilterSelection.initial] (all three empty) = show all, which
  /// preserves the unfiltered feed on load.
  ///
  /// Every dimension maps to a real PII-free [FeedItem] field; distance and
  /// shift are deliberately absent because neither is on the wire. See
  /// `domain/job_filter.dart` for the matching rules.
  final FilterSelection filters;

  /// [queue] narrowed to [filters] (AND across dimensions, OR within one). This
  /// is what the deck renders AND what apply/skip act on (via [current]), so the
  /// visible head is always the card the worker actually decides.
  List<FeedItem> get visibleQueue => applyJobFilters(queue, filters);

  /// True when jobs remain but none match the active filter — a distinct empty
  /// state ("no jobs match") from the drained-queue empty state ("no more jobs").
  bool get filteredOut => queue.isNotEmpty && visibleQueue.isEmpty;

  /// True while an apply/skip call for the current card is in flight (blocks a
  /// double-decision).
  final bool deciding;

  /// Monotonic nonce bumped on a failed apply/skip. A transient side effect, not
  /// persistent state — a `BlocListener(listenWhen:)` fires exactly one snackbar
  /// per bump and never re-fires on unrelated rebuilds.
  final int decisionError;

  /// Monotonic nonce bumped on a SUCCESSFUL apply. The Feed listens on this to
  /// navigate to the Applied confirmation only once the apply truly succeeded
  /// (avoids navigating optimistically and diverging on a failed apply).
  final int appliedNonce;

  /// Monotonic nonce bumped on a SUCCESSFUL prioritize (up-swipe). The Feed
  /// listens on this to toast "Priority" once the local record succeeded.
  final int prioritizedNonce;

  /// The head of the FILTERED deck — the card apply/skip target.
  FeedItem? get current => visibleQueue.isEmpty ? null : visibleQueue.first;

  SwipeState copyWith({
    SwipeStatus? status,
    List<FeedItem>? queue,
    FilterSelection? filters,
    bool? deciding,
    int? decisionError,
    int? appliedNonce,
    int? prioritizedNonce,
    Failure? failure,
  }) {
    return SwipeState(
      status: status ?? this.status,
      queue: queue ?? this.queue,
      filters: filters ?? this.filters,
      deciding: deciding ?? this.deciding,
      decisionError: decisionError ?? this.decisionError,
      appliedNonce: appliedNonce ?? this.appliedNonce,
      prioritizedNonce: prioritizedNonce ?? this.prioritizedNonce,
      failure: failure ?? this.failure,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        queue,
        filters,
        deciding,
        decisionError,
        appliedNonce,
        prioritizedNonce,
        failure,
      ];
}

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
    this.failure,
    this.nextCursor,
  });

  final SwipeStatus status;

  /// The typed cause when [status] is `error` — the error view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  /// ALL remaining undecided cards (unfiltered). A failed apply/skip leaves the
  /// decided card untouched so nothing is lost on a network drop.
  final List<FeedItem> queue;

  /// The active filter selection — Trade, City, Experience, Shift and a pay floor
  /// (from the "Filter jobs" sheet; Trade also from the Feed's top chip row —
  /// they share this one source of truth). [FilterSelection.initial] (all unset)
  /// = show all, which preserves the unfiltered feed on load.
  ///
  /// Every dimension maps to a real PII-free [FeedItem] field. Shift + pay are on
  /// the `/feed` wire (ADR-0024 addendum), so they narrow the deck client-side AND
  /// ride `GET /feed` as `shift` / `pay_min`; only DISTANCE stays out (not
  /// modelled). See `domain/job_filter.dart` for the matching rules.
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

  /// The OPAQUE `next_cursor` of the last page loaded into [queue] (#2068,
  /// ADR-0052) — the position [SwipeNextPageRequested] resumes from, stored and
  /// resent byte-for-byte and NEVER parsed or constructed here.
  ///
  /// Null means "do not page", which covers all three of: the deck's end (the
  /// server said null), a server that does not send the key at all (an older
  /// build / a rollback), and a cursor DROPPED because the scroll it belonged to
  /// is void — a filter change or a page-1 (re)load. Those are deliberately one
  /// state: in every one of them the only legal next call is page 1.
  final String? nextCursor;

  /// True when the server has handed us a position to continue from. Paging is
  /// the only thing that may read [nextCursor] — nothing renders it.
  bool get hasMorePages => nextCursor != null;


  /// The head of the FILTERED deck — the card apply/skip target.
  FeedItem? get current => visibleQueue.isEmpty ? null : visibleQueue.first;

  /// [nextCursor] takes the `_sentinel` default rather than `null`, because for
  /// this one field null is a REAL value the caller must be able to write: "the
  /// deck ends here / this cursor is void". `nextCursor: null` therefore CLEARS
  /// it, while omitting the argument keeps the current one (the plain `??`
  /// pattern every other field uses cannot express the difference).
  SwipeState copyWith({
    SwipeStatus? status,
    List<FeedItem>? queue,
    FilterSelection? filters,
    bool? deciding,
    int? decisionError,
    int? appliedNonce,
    Failure? failure,
    Object? nextCursor = _sentinel,
  }) {
    return SwipeState(
      status: status ?? this.status,
      queue: queue ?? this.queue,
      filters: filters ?? this.filters,
      deciding: deciding ?? this.deciding,
      decisionError: decisionError ?? this.decisionError,
      appliedNonce: appliedNonce ?? this.appliedNonce,
      failure: failure ?? this.failure,
      nextCursor:
          nextCursor == _sentinel ? this.nextCursor : nextCursor as String?,
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
        failure,
        nextCursor,
      ];
}

/// "Argument not passed", so a nullable field can be set back to null through
/// [SwipeState.copyWith]. Same idiom as `finishing_models.dart`.
const Object _sentinel = Object();

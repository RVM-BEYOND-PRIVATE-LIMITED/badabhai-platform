import 'package:equatable/equatable.dart';

import '../../../../core/api/api_models.dart';
import '../../../../core/error/failure.dart';

enum SwipeStatus { loading, ready, empty, error, consentRequired }

class SwipeState extends Equatable {
  const SwipeState({
    this.status = SwipeStatus.loading,
    this.queue = const <FeedItem>[],
    this.deciding = false,
    this.decisionError = 0,
    this.appliedNonce = 0,
    this.failure,
  });

  final SwipeStatus status;

  /// The typed cause when [status] is `error` — the error view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  /// Remaining cards; the worker's place is the head. A failed apply/skip leaves
  /// the head untouched so nothing is lost on a network drop.
  final List<FeedItem> queue;

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


  FeedItem? get current => queue.isEmpty ? null : queue.first;

  SwipeState copyWith({
    SwipeStatus? status,
    List<FeedItem>? queue,
    bool? deciding,
    int? decisionError,
    int? appliedNonce,
    Failure? failure,
  }) {
    return SwipeState(
      status: status ?? this.status,
      queue: queue ?? this.queue,
      deciding: deciding ?? this.deciding,
      decisionError: decisionError ?? this.decisionError,
      appliedNonce: appliedNonce ?? this.appliedNonce,
      failure: failure ?? this.failure,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        status,
        queue,
        deciding,
        decisionError,
        appliedNonce,
        failure,
      ];
}

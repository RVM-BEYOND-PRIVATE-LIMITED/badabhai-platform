import 'package:equatable/equatable.dart';

/// #2984 — the company's answer to "did you hire this person?".
///
/// The wire values are the closed set the API accepts on
/// `POST /payer/unlocks/:unlockId/outcome`; [label] is the short button copy.
/// `not_reached` is the desk's answer, never a company's, so it is deliberately
/// absent here.
enum UnlockFollowupOutcome {
  hired('hired', 'Hired'),
  notHired('not_hired', 'Not hired'),
  stillTalking('still_talking', 'Still talking');

  const UnlockFollowupOutcome(this.wire, this.label);

  final String wire;
  final String label;

  static UnlockFollowupOutcome? tryParse(Object? value) {
    if (value is! String) return null;
    for (final UnlockFollowupOutcome outcome in values) {
      if (outcome.wire == value) return outcome;
    }
    return null;
  }
}

/// A STORED answer, including the desk's `not_reached` (#2750). Only the three
/// company answers above may be posted; this wider set exists so a response can
/// report what the previous answer was without failing the contract.
enum UnlockStoredOutcome {
  hired('hired'),
  notHired('not_hired'),
  stillTalking('still_talking'),
  notReached('not_reached');

  const UnlockStoredOutcome(this.wire);

  final String wire;

  static UnlockStoredOutcome? tryParse(Object? value) {
    if (value is! String) return null;
    for (final UnlockStoredOutcome outcome in values) {
      if (outcome.wire == value) return outcome;
    }
    return null;
  }

  /// Maps a company answer to its stored counterpart.
  static UnlockStoredOutcome? fromCompany(UnlockFollowupOutcome? outcome) =>
      outcome == null ? null : tryParse(outcome.wire);
}

/// One due contact from `GET /payer/unlock-outcomes/due`.
///
/// PII-FREE by contract: an opaque unlock/worker id, the grant time and the
/// current answer. It carries no name, phone or posting title, so Home can show
/// the row without ever describing the worker.
class UnlockFollowupItem extends Equatable {
  const UnlockFollowupItem({
    required this.unlockId,
    required this.workerId,
    required this.grantedAt,
    this.outcome,
  });

  final String unlockId;
  final String workerId;

  /// The grant timestamp as the server sent it (ISO-8601). Kept as the wire
  /// string so the display layer can parse it without losing the contract.
  final String grantedAt;

  /// Null when the company has not answered yet; `still_talking` when an earlier
  /// answer asked again after the wait. Any other value means the contact is no
  /// longer due (the server would not list it).
  final UnlockFollowupOutcome? outcome;

  /// Null when the row is not the contract (missing id/timestamp or an unknown
  /// answer), so the page read fails instead of inventing a row.
  static UnlockFollowupItem? tryFromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final Object? unlockId = json['unlock_id'];
    final Object? workerId = json['worker_id'];
    final Object? grantedAt = json['granted_at'];
    if (unlockId is! String ||
        unlockId.isEmpty ||
        workerId is! String ||
        workerId.isEmpty ||
        grantedAt is! String ||
        grantedAt.isEmpty ||
        DateTime.tryParse(grantedAt) == null) {
      return null;
    }
    final Object? rawOutcome = json['outcome'];
    final UnlockFollowupOutcome? outcome;
    if (rawOutcome == null) {
      outcome = null;
    } else {
      outcome = UnlockFollowupOutcome.tryParse(rawOutcome);
      if (outcome == null) return null;
    }
    return UnlockFollowupItem(
      unlockId: unlockId,
      workerId: workerId,
      grantedAt: grantedAt,
      outcome: outcome,
    );
  }

  @override
  List<Object?> get props => <Object?>[unlockId, workerId, grantedAt, outcome];
}

/// One page of due contacts (`GET /payer/unlock-outcomes/due`).
///
/// [nextCursor] is the opaque position to pass back for the next page, or null
/// on the last page. A 2xx that is not this shape is a contract error — callers
/// never read a missing `items` list as "nothing is due".
class UnlockFollowupPage extends Equatable {
  const UnlockFollowupPage({
    required this.items,
    this.nextCursor,
  });

  final List<UnlockFollowupItem> items;
  final String? nextCursor;

  bool get hasMore => nextCursor != null;

  static UnlockFollowupPage? tryFromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final Object? rows = json['items'];
    if (rows is! List<dynamic>) return null;
    final Object? cursor = json['nextCursor'];
    if (cursor != null && cursor is! String) return null;
    final List<UnlockFollowupItem> items = <UnlockFollowupItem>[];
    for (final Object? row in rows) {
      final UnlockFollowupItem? item = UnlockFollowupItem.tryFromJson(row);
      if (item == null) return null;
      items.add(item);
    }
    return UnlockFollowupPage(
      items: List<UnlockFollowupItem>.unmodifiable(items),
      nextCursor: cursor is String && cursor.isNotEmpty ? cursor : null,
    );
  }

  @override
  List<Object?> get props => <Object?>[items, nextCursor];
}

/// The 200 body of `POST /payer/unlocks/:unlockId/outcome`.
///
/// [previousOutcome] is the answer stored before this one (null on the first)
/// and [changed] is false for an idempotent repeat. The row itself leaves the
/// due list after any successful answer, so the UI removes it by [unlockId].
class UnlockFollowupResult extends Equatable {
  const UnlockFollowupResult({
    required this.unlockId,
    required this.workerId,
    required this.outcome,
    required this.previousOutcome,
    required this.answeredAt,
    required this.changed,
  });

  final String unlockId;
  final String workerId;
  final UnlockFollowupOutcome outcome;
  final UnlockStoredOutcome? previousOutcome;
  final String answeredAt;
  final bool changed;

  static UnlockFollowupResult? tryFromJson(Object? json) {
    if (json is! Map<String, dynamic>) return null;
    final Object? unlockId = json['unlock_id'];
    final Object? workerId = json['worker_id'];
    final Object? answeredAt = json['answered_at'];
    final Object? changed = json['changed'];
    final UnlockFollowupOutcome? outcome =
        UnlockFollowupOutcome.tryParse(json['outcome']);
    if (unlockId is! String ||
        unlockId.isEmpty ||
        workerId is! String ||
        workerId.isEmpty ||
        outcome == null ||
        answeredAt is! String ||
        answeredAt.isEmpty ||
        DateTime.tryParse(answeredAt) == null ||
        changed is! bool) {
      return null;
    }
    final Object? rawPrevious = json['previous_outcome'];
    final UnlockStoredOutcome? previous;
    if (rawPrevious == null) {
      previous = null;
    } else {
      previous = UnlockStoredOutcome.tryParse(rawPrevious);
      if (previous == null) return null;
    }
    return UnlockFollowupResult(
      unlockId: unlockId,
      workerId: workerId,
      outcome: outcome,
      previousOutcome: previous,
      answeredAt: answeredAt,
      changed: changed,
    );
  }

  @override
  List<Object?> get props => <Object?>[
        unlockId,
        workerId,
        outcome,
        previousOutcome,
        answeredAt,
        changed,
      ];
}

import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/data/models.dart';
import '../../../../core/data/payer_api_client.dart';
import '../../../../core/data/unlock_followup_models.dart';
import '../../../../core/util/idempotency_key.dart';
import '../../../../core/util/read_order.dart';

/// Drives Home's "Did you hire this person?" section
/// (`GET /payer/unlock-outcomes/due` + `POST /payer/unlocks/:unlockId/outcome`).
///
/// The section is OPT-IN by data: it shows only while [FollowupState.visible]
/// (a ready page with at least one due row). A neutral 404 means the feature is
/// off and is remembered as [FollowupStatus.off]; any other read failure is an
/// error, NEVER an empty success. A successful answer removes that row at once,
/// and the idempotency key for one answer intent is reused if the payer retries
/// the same intent.
class FollowupCubit extends Cubit<FollowupState> {
  FollowupCubit(
    this._api, {
    String Function()? mintKey,
  })  : _mintKey = mintKey ?? newIdempotencyKey,
        super(const FollowupState());

  final PayerApiClient _api;
  final String Function() _mintKey;

  /// Ordered reads, so a return-to-tab refresh cannot overwrite a newer load
  /// (or an answer's row removal) with an older response.
  final ReadOrder _reads = ReadOrder();

  /// One PII-free key per answer intent (`unlockId:outcome`). Kept on a failed
  /// attempt so retrying the SAME intent replays rather than records again.
  final Map<String, String> _intentKeys = <String, String>{};

  Future<void> load({int limit = 20}) async {
    final int read = _reads.start();
    emit(state.copyWith(status: FollowupStatus.loading, answerError: null));
    try {
      final UnlockFollowupPage? page =
          await _api.fetchDueUnlockOutcomes(limit: limit);
      if (isClosed || !_reads.claim(read)) return;
      if (page == null) {
        emit(const FollowupState(status: FollowupStatus.off));
        return;
      }
      emit(FollowupState(
        status: FollowupStatus.ready,
        items: page.items,
        nextCursor: page.nextCursor,
      ));
    } on PayerApiException catch (e) {
      if (isClosed || !_reads.isLatest(read)) return;
      _reads.settle(read);
      emit(e.statusCode == 404
          ? const FollowupState(status: FollowupStatus.off)
          : state.copyWith(status: FollowupStatus.error));
    } catch (_) {
      if (isClosed || !_reads.isLatest(read)) return;
      _reads.settle(read);
      emit(state.copyWith(status: FollowupStatus.error));
    }
  }

  /// A silent re-read for a return to Home (or pull-to-refresh): the rows on
  /// screen stay until the fresh page lands. A 404/error simply hides the card;
  /// it never turns a failed read into a confident empty list.
  Future<void> refresh() async {
    if (state.status == FollowupStatus.initial ||
        state.status == FollowupStatus.loading ||
        state.status == FollowupStatus.off) {
      return;
    }
    final int read = _reads.start();
    try {
      final UnlockFollowupPage? page = await _api.fetchDueUnlockOutcomes();
      if (isClosed || !_reads.claim(read)) return;
      if (page == null) {
        emit(const FollowupState(status: FollowupStatus.off));
        return;
      }
      emit(state.copyWith(
        status: FollowupStatus.ready,
        items: page.items,
        nextCursor: page.nextCursor,
        answerError: null,
      ));
    } on PayerApiException catch (e) {
      if (isClosed || !_reads.isLatest(read)) return;
      _reads.settle(read);
      emit(e.statusCode == 404
          ? const FollowupState(status: FollowupStatus.off)
          : state.copyWith(status: FollowupStatus.error));
    } catch (_) {
      if (isClosed || !_reads.isLatest(read)) return;
      _reads.settle(read);
      emit(state.copyWith(status: FollowupStatus.error));
    }
  }

  /// Fetch the next page into the sheet. A failure keeps the rows already on
  /// screen and only stops the "load more" affordance; it never clears them.
  Future<void> loadMore() async {
    final String? cursor = state.nextCursor;
    if (cursor == null ||
        state.loadingMore ||
        state.status != FollowupStatus.ready) {
      return;
    }
    emit(state.copyWith(loadingMore: true));
    try {
      final UnlockFollowupPage? page =
          await _api.fetchDueUnlockOutcomes(cursor: cursor);
      if (isClosed) return;
      if (page == null) {
        emit(const FollowupState(status: FollowupStatus.off));
        return;
      }
      final Set<String> seen =
          state.items.map((UnlockFollowupItem i) => i.unlockId).toSet();
      final List<UnlockFollowupItem> merged = <UnlockFollowupItem>[
        ...state.items,
        ...page.items.where((UnlockFollowupItem i) => seen.add(i.unlockId)),
      ];
      emit(state.copyWith(
        status: FollowupStatus.ready,
        items: List<UnlockFollowupItem>.unmodifiable(merged),
        nextCursor: page.nextCursor,
        loadingMore: false,
      ));
    } catch (_) {
      if (!isClosed) emit(state.copyWith(loadingMore: false));
    }
  }

  /// Record [outcome] for [item]. A success (or the neutral 404) removes the row
  /// because the server no longer lists it as due. A 429/failure keeps the row
  /// and its idempotency key, so a retry of the SAME intent is safe.
  Future<FollowupAnswerResult> answer(
    UnlockFollowupItem item,
    UnlockFollowupOutcome outcome,
  ) async {
    if (state.pending.containsKey(item.unlockId)) {
      return FollowupAnswerResult.failed;
    }
    final String intent = '${item.unlockId}:${outcome.wire}';
    final String key = _intentKeys.putIfAbsent(intent, _mintKey);
    emit(state.copyWith(
      pending: <String, UnlockFollowupOutcome>{
        ...state.pending,
        item.unlockId: outcome,
      },
      answerError: null,
    ));
    try {
      await _api.recordUnlockOutcome(
        unlockId: item.unlockId,
        outcome: outcome,
        idempotencyKey: key,
      );
      _intentKeys.remove(intent);
      if (!isClosed) _drop(item.unlockId);
      return FollowupAnswerResult.saved;
    } on PayerApiException catch (e) {
      // 404 is terminal (the row is stale), so its intent key is done. Any other
      // failure keeps the key: a retry of the SAME intent must replay, not
      // record a second answer.
      if (e.statusCode == 404) _intentKeys.remove(intent);
      if (!isClosed) {
        if (e.statusCode == 404) {
          // Unknown/foreign/erased: the row is stale, not the payer's mistake.
          _drop(item.unlockId);
          return FollowupAnswerResult.notFound;
        }
        _settleFailure(
          item.unlockId,
          e.statusCode == 429 ? 'rate_limited' : 'failed',
        );
      }
      return e.statusCode == 429
          ? FollowupAnswerResult.rateLimited
          : FollowupAnswerResult.failed;
    } catch (_) {
      // Transport failure: the server may have seen the write, so keep the key
      // for the retry of this intent.
      if (!isClosed) _settleFailure(item.unlockId, 'failed');
      return FollowupAnswerResult.failed;
    }
  }

  void _drop(String unlockId) {
    emit(state.copyWith(
      items: state.items
          .where((UnlockFollowupItem i) => i.unlockId != unlockId)
          .toList(growable: false),
      pending: _withoutPending(unlockId),
      answerError: null,
    ));
  }

  void _settleFailure(String unlockId, String reason) {
    emit(state.copyWith(
      pending: _withoutPending(unlockId),
      answerError: reason,
    ));
  }

  Map<String, UnlockFollowupOutcome> _withoutPending(String unlockId) {
    final Map<String, UnlockFollowupOutcome> next =
        Map<String, UnlockFollowupOutcome>.of(state.pending);
    next.remove(unlockId);
    return next;
  }
}

enum FollowupStatus { initial, loading, ready, off, error }

enum FollowupAnswerResult { saved, notFound, rateLimited, failed }

const Object _unset = Object();

class FollowupState extends Equatable {
  const FollowupState({
    this.status = FollowupStatus.initial,
    this.items = const <UnlockFollowupItem>[],
    this.nextCursor,
    this.pending = const <String, UnlockFollowupOutcome>{},
    this.answerError,
    this.loadingMore = false,
  });

  final FollowupStatus status;
  final List<UnlockFollowupItem> items;
  final String? nextCursor;

  /// Unlock id → the outcome currently being recorded for it.
  final Map<String, UnlockFollowupOutcome> pending;

  /// Why the last answer failed, for the optional toast; null after a success.
  final String? answerError;
  final bool loadingMore;

  /// The section renders only on a ready page with due rows.
  bool get visible => status == FollowupStatus.ready && items.isNotEmpty;

  bool get hasMore => nextCursor != null;

  bool isAnswering(String unlockId) => pending.containsKey(unlockId);

  UnlockFollowupOutcome? pendingOutcomeFor(String unlockId) =>
      pending[unlockId];

  FollowupState copyWith({
    FollowupStatus? status,
    List<UnlockFollowupItem>? items,
    Object? nextCursor = _unset,
    Map<String, UnlockFollowupOutcome>? pending,
    Object? answerError = _unset,
    bool? loadingMore,
  }) {
    return FollowupState(
      status: status ?? this.status,
      items: items ?? this.items,
      nextCursor: identical(nextCursor, _unset)
          ? this.nextCursor
          : nextCursor as String?,
      pending: pending ?? this.pending,
      answerError: identical(answerError, _unset)
          ? this.answerError
          : answerError as String?,
      loadingMore: loadingMore ?? this.loadingMore,
    );
  }

  @override
  List<Object?> get props =>
      <Object?>[status, items, nextCursor, pending, answerError, loadingMore];
}

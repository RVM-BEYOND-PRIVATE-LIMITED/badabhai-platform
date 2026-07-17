import 'package:equatable/equatable.dart';
import 'package:flutter_bloc/flutter_bloc.dart';

import '../../../../core/error/failure.dart';
import '../../domain/app_notification.dart';
import '../../domain/notifications_repository.dart';

enum NotificationsStatus { loading, ready, empty, failed }

class NotificationsState extends Equatable {
  const NotificationsState({
    this.status = NotificationsStatus.loading,
    this.items = const <AppNotification>[],
    this.failure,
  });

  final NotificationsStatus status;
  final List<AppNotification> items;

  /// The typed cause when [status] is `failed` — the failed view surfaces its
  /// honest reason instead of a generic "check internet" line.
  final Failure? failure;

  @override
  List<Object?> get props => <Object?>[status, items, failure];
}

/// Drives the Alerts screen: opening the tab loads the rows and marks them read.
/// The repository owns the reactive unread count the nav badge reads.
class NotificationsCubit extends Cubit<NotificationsState> {
  NotificationsCubit(this._repo) : super(const NotificationsState());

  final NotificationsRepository _repo;

  /// True while a load is in flight — the tab-focus refetch must not stack a
  /// second one on top of the create:-time load.
  bool _loading = false;

  Future<void> load() async {
    if (_loading) return;
    _loading = true;
    emit(const NotificationsState(status: NotificationsStatus.loading));
    try {
      final List<AppNotification> items = await _repo.list();
      if (isClosed) return;
      _emitList(items);
    } on Failure catch (f) {
      if (isClosed) return;
      emit(NotificationsState(status: NotificationsStatus.failed, failure: f));
    } finally {
      _loading = false;
    }
  }

  /// Opening the Alerts tab IS the read (T5) — there is no tick to press.
  ///
  /// Fetch, show the rows, then mark them read and re-emit the SAME rows as
  /// read. Deliberately NOT `markAllRead()`: that re-runs `list()`, a second
  /// network round-trip for rows already in hand.
  ///
  /// The badge is cleared on load SUCCESS, never on focus. Clearing at focus
  /// would lie whenever `list()` then failed — the worker would see 0 unread
  /// while the alerts were never actually shown to them.
  ///
  /// On failure nothing is marked read and the badge stays lit, and a refetch
  /// blip does not wipe rows the worker can already see.
  Future<void> loadAndMarkRead() async {
    if (_loading) return;
    _loading = true;
    try {
      final List<AppNotification> items = await _repo.list();
      if (isClosed) return;
      _emitList(items);

      // Session-local + synchronous (no network): remembers the shown ids and
      // zeroes the badge. Only reached because list() succeeded.
      await _repo.markAllRead();
      if (isClosed) return;
      _emitList(items
          .map((AppNotification n) => n.copyWith(read: true))
          .toList(growable: false));
    } on Failure catch (f) {
      if (isClosed) return;
      // Keep good rows on screen; only surface the failure if there were none.
      if (state.status != NotificationsStatus.ready &&
          state.status != NotificationsStatus.empty) {
        emit(NotificationsState(status: NotificationsStatus.failed, failure: f));
      }
    } finally {
      _loading = false;
    }
  }

  void _emitList(List<AppNotification> items) {
    emit(NotificationsState(
      status: items.isEmpty
          ? NotificationsStatus.empty
          : NotificationsStatus.ready,
      items: items,
    ));
  }
}

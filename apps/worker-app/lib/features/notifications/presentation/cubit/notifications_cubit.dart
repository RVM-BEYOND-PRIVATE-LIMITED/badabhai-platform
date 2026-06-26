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
  });

  final NotificationsStatus status;
  final List<AppNotification> items;

  @override
  List<Object?> get props => <Object?>[status, items];
}

/// Drives the Alerts screen: load on open, mark-all-read on the app-bar action.
/// The repository owns the reactive unread count the nav badge reads.
class NotificationsCubit extends Cubit<NotificationsState> {
  NotificationsCubit(this._repo) : super(const NotificationsState());

  final NotificationsRepository _repo;

  Future<void> load() async {
    emit(const NotificationsState(status: NotificationsStatus.loading));
    try {
      final List<AppNotification> items = await _repo.list();
      if (isClosed) return;
      _emitList(items);
    } on Failure catch (_) {
      if (isClosed) return;
      emit(const NotificationsState(status: NotificationsStatus.failed));
    }
  }

  Future<void> markAllRead() async {
    await _repo.markAllRead();
    if (isClosed) return;
    final List<AppNotification> items = await _repo.list();
    if (isClosed) return;
    _emitList(items);
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

import 'package:flutter/foundation.dart';

import 'app_notification.dart';

/// Read/mutate boundary for alerts (spec §5.11). [unreadCount] is reactive so the
/// bottom-nav badge updates without a rebuild plumbed through the widget tree.
abstract interface class NotificationsRepository {
  /// Reactive unread count for the [BbBottomNav] Alerts badge.
  ValueListenable<int> get unreadCount;

  Future<List<AppNotification>> list();

  Future<void> markAllRead();
}

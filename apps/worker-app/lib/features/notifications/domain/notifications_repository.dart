import 'package:flutter/foundation.dart';

import 'app_notification.dart';

/// Read/mutate boundary for alerts (spec §5.11). [unreadCount] is reactive so the
/// bottom-nav badge updates without a rebuild plumbed through the widget tree.
abstract interface class NotificationsRepository {
  /// Reactive unread count for the [BbBottomNav] Alerts badge.
  ValueListenable<int> get unreadCount;

  Future<List<AppNotification>> list();

  Future<void> markAllRead();

  /// Best-effort background fetch to populate [unreadCount] BEFORE the Alerts
  /// screen is opened (the nav badge shows the count on app open). Never throws —
  /// a fetch failure leaves the current count.
  Future<void> refresh();
}

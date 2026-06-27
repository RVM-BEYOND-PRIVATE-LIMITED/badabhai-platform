import 'package:flutter/foundation.dart';

import '../domain/app_notification.dart';
import '../domain/notifications_repository.dart';

/// MOCK-ONLY notifications for the alpha. All ids are `mock-*` sentinels and the
/// content is PII-free (mock employer names are fabricated display strings, never
/// real PII, never sent to an LLM/event/ai_jobs/audit_logs/log). Resume-ready is
/// a local signal; new-job / profile-viewed are placeholders for deferred server
/// signals (§7). Read/unread is session-only in-memory state. Registered as a
/// lazySingleton so the Alerts screen and the shell badge share one instance.
class NotificationsRepositoryImpl implements NotificationsRepository {
  NotificationsRepositoryImpl();

  final List<AppNotification> _items = <AppNotification>[
    const AppNotification(
      id: 'mock-n1',
      kind: NotificationKind.newJob,
      title: 'Naya job — CNC Operator',
      subtitle: 'Sharma Precision Works · Pimpri · ₹22–28k',
      time: 'Abhi',
    ),
    const AppNotification(
      id: 'mock-n2',
      kind: NotificationKind.profileViewed,
      title: 'Employer ne aapka profile dekha',
      subtitle: 'Deccan Auto Components',
      time: '2 ghante',
    ),
    const AppNotification(
      id: 'mock-n3',
      kind: NotificationKind.resumeReady,
      title: 'Aapka resume taiyaar hai',
      subtitle: 'Download ya WhatsApp pe share karein',
      time: 'Kal',
      read: true,
    ),
  ];

  late final ValueNotifier<int> _unread = ValueNotifier<int>(_countUnread());

  int _countUnread() => _items.where((AppNotification n) => !n.read).length;

  @override
  ValueListenable<int> get unreadCount => _unread;

  @override
  Future<List<AppNotification>> list() async {
    await Future<void>.delayed(const Duration(milliseconds: 300));
    return List<AppNotification>.unmodifiable(_items);
  }

  @override
  Future<void> markAllRead() async {
    for (int i = 0; i < _items.length; i++) {
      _items[i] = _items[i].copyWith(read: true);
    }
    _unread.value = 0;
  }
}

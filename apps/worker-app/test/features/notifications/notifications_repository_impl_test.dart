import 'package:flutter_test/flutter_test.dart';

import 'package:badabhai_worker_app/features/notifications/data/notifications_repository_impl.dart';
import 'package:badabhai_worker_app/features/notifications/domain/app_notification.dart';

void main() {
  test('starts with the canned unread count (2) and clears on markAllRead — '
      'the nav badge source', () async {
    final NotificationsRepositoryImpl repo = NotificationsRepositoryImpl();

    expect(repo.unreadCount.value, 2);
    expect(await repo.list(), hasLength(3));

    await repo.markAllRead();

    expect(repo.unreadCount.value, 0);
    final List<AppNotification> after = await repo.list();
    expect(after.every((AppNotification n) => n.read), isTrue);
  });
}

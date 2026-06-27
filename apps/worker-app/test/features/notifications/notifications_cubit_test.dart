import 'package:bloc_test/bloc_test.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/notifications/domain/app_notification.dart';
import 'package:badabhai_worker_app/features/notifications/domain/notifications_repository.dart';
import 'package:badabhai_worker_app/features/notifications/presentation/cubit/notifications_cubit.dart';

class MockNotificationsRepository extends Mock
    implements NotificationsRepository {}

const List<AppNotification> _items = <AppNotification>[
  AppNotification(
    id: 'mock-n1',
    kind: NotificationKind.newJob,
    title: 'Naya job',
    subtitle: 'X',
    time: 'Abhi',
  ),
];

void main() {
  late MockNotificationsRepository repo;
  setUp(() => repo = MockNotificationsRepository());

  blocTest<NotificationsCubit, NotificationsState>(
    'load -> loading then ready with items',
    build: () {
      when(() => repo.list()).thenAnswer((_) async => _items);
      return NotificationsCubit(repo);
    },
    act: (NotificationsCubit c) => c.load(),
    expect: () => const <NotificationsState>[
      NotificationsState(status: NotificationsStatus.loading),
      NotificationsState(status: NotificationsStatus.ready, items: _items),
    ],
  );

  blocTest<NotificationsCubit, NotificationsState>(
    'empty list -> empty state',
    build: () {
      when(() => repo.list()).thenAnswer((_) async => const <AppNotification>[]);
      return NotificationsCubit(repo);
    },
    act: (NotificationsCubit c) => c.load(),
    expect: () => const <NotificationsState>[
      NotificationsState(status: NotificationsStatus.loading),
      NotificationsState(status: NotificationsStatus.empty),
    ],
  );

  blocTest<NotificationsCubit, NotificationsState>(
    'load failure -> failed',
    build: () {
      when(() => repo.list()).thenThrow(const NetworkFailure());
      return NotificationsCubit(repo);
    },
    act: (NotificationsCubit c) => c.load(),
    expect: () => const <NotificationsState>[
      NotificationsState(status: NotificationsStatus.loading),
      NotificationsState(status: NotificationsStatus.failed),
    ],
  );

  blocTest<NotificationsCubit, NotificationsState>(
    'markAllRead calls the repo and re-emits the list',
    build: () {
      when(() => repo.markAllRead()).thenAnswer((_) async {});
      when(() => repo.list()).thenAnswer((_) async => _items);
      return NotificationsCubit(repo);
    },
    act: (NotificationsCubit c) => c.markAllRead(),
    expect: () => const <NotificationsState>[
      NotificationsState(status: NotificationsStatus.ready, items: _items),
    ],
    verify: (_) => verify(() => repo.markAllRead()).called(1),
  );

  test('the reactive unreadCount is a ValueListenable<int>', () {
    final ValueNotifier<int> n = ValueNotifier<int>(2);
    when(() => repo.unreadCount).thenReturn(n);
    expect(repo.unreadCount.value, 2);
    n.dispose();
  });
}

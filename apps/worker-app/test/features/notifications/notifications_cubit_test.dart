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
    id: 'e1',
    kind: NotificationKind.resumeReady,
    title: 'Resume taiyaar hai',
    subtitle: 'Aapka naya resume ban gaya.',
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
      NotificationsState(
          status: NotificationsStatus.failed, failure: NetworkFailure()),
    ],
  );

  // T5 — the tick is gone: opening the Alerts tab IS the read.
  group('loadAndMarkRead (T5)', () {
    blocTest<NotificationsCubit, NotificationsState>(
      'shows the rows, marks them read, re-emits as read — with ONE list() call',
      build: () {
        when(() => repo.markAllRead()).thenAnswer((_) async {});
        when(() => repo.list()).thenAnswer((_) async => _items);
        return NotificationsCubit(repo);
      },
      act: (NotificationsCubit c) => c.loadAndMarkRead(),
      expect: () => <NotificationsState>[
        const NotificationsState(
            status: NotificationsStatus.ready, items: _items),
        NotificationsState(
          status: NotificationsStatus.ready,
          items: _items
              .map((AppNotification n) => n.copyWith(read: true))
              .toList(growable: false),
        ),
      ],
      verify: (_) {
        verify(() => repo.markAllRead()).called(1);
        // The old markAllRead() re-ran list() to re-map the rows — a second
        // network round-trip for rows already in hand.
        verify(() => repo.list()).called(1);
      },
    );

    blocTest<NotificationsCubit, NotificationsState>(
      'a FAILED load marks nothing read — the badge must stay lit',
      build: () {
        when(() => repo.list()).thenThrow(const NetworkFailure());
        return NotificationsCubit(repo);
      },
      act: (NotificationsCubit c) => c.loadAndMarkRead(),
      expect: () => const <NotificationsState>[
        NotificationsState(
            status: NotificationsStatus.failed, failure: NetworkFailure()),
      ],
      // Clearing the badge on FOCUS rather than on load success would lie here:
      // the worker would see 0 unread having never been shown the alerts.
      verify: (_) => verifyNever(() => repo.markAllRead()),
    );

    blocTest<NotificationsCubit, NotificationsState>(
      'a failed REFETCH keeps the rows already on screen',
      build: () {
        when(() => repo.list()).thenThrow(const NetworkFailure());
        return NotificationsCubit(repo);
      },
      seed: () => const NotificationsState(
          status: NotificationsStatus.ready, items: _items),
      act: (NotificationsCubit c) => c.loadAndMarkRead(),
      // Nothing emitted: a blip must not replace readable alerts with an error.
      expect: () => const <NotificationsState>[],
    );

    test('overlapping loads are ignored', () async {
      int calls = 0;
      when(() => repo.markAllRead()).thenAnswer((_) async {});
      when(() => repo.list()).thenAnswer((_) async {
        calls++;
        await Future<void>.delayed(const Duration(milliseconds: 50));
        return _items;
      });
      final NotificationsCubit c = NotificationsCubit(repo);
      addTearDown(c.close);

      // Tab focus can fire while the create:-time load is still in flight.
      await Future.wait<void>(<Future<void>>[
        c.loadAndMarkRead(),
        c.loadAndMarkRead(),
      ]);

      expect(calls, 1, reason: 'the second load must be ignored, not stacked');
    });
  });

  test('the reactive unreadCount is a ValueListenable<int>', () {
    final ValueNotifier<int> n = ValueNotifier<int>(2);
    when(() => repo.unreadCount).thenReturn(n);
    expect(repo.unreadCount.value, 2);
    n.dispose();
  });
}

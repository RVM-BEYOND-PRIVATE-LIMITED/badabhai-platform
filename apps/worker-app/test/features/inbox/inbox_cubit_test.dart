import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/inbox/domain/inbox_models.dart';
import 'package:badabhai_worker_app/features/inbox/domain/inbox_repository.dart';
import 'package:badabhai_worker_app/features/inbox/presentation/cubit/inbox_cubit.dart';
import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class MockInboxRepository extends Mock implements InboxRepository {}

InboxThread _thread(String id, {int unread = 0}) => InboxThread(
      unlockId: id,
      lastMessageAt: DateTime.utc(2026, 9, 21),
      unreadCount: unread,
    );

void main() {
  late MockInboxRepository repo;

  setUp(() => repo = MockInboxRepository());

  blocTest<InboxCubit, InboxState>(
    'load emits loading then ready with the threads',
    build: () {
      when(() => repo.threads())
          .thenAnswer((_) async => <InboxThread>[_thread('u1', unread: 1)]);
      return InboxCubit(repo);
    },
    act: (InboxCubit c) => c.load(),
    expect: () => <InboxState>[
      const InboxState(status: InboxStatus.loading),
      InboxState(status: InboxStatus.ready, threads: <InboxThread>[_thread('u1', unread: 1)]),
    ],
  );

  blocTest<InboxCubit, InboxState>(
    'an empty list is the empty state, not ready',
    build: () {
      when(() => repo.threads()).thenAnswer((_) async => <InboxThread>[]);
      return InboxCubit(repo);
    },
    act: (InboxCubit c) => c.load(),
    expect: () => <InboxState>[
      const InboxState(status: InboxStatus.loading),
      const InboxState(status: InboxStatus.empty),
    ],
  );

  blocTest<InboxCubit, InboxState>(
    'a Failure becomes the failed state carrying the typed reason',
    build: () {
      when(() => repo.threads()).thenThrow(const NetworkFailure());
      return InboxCubit(repo);
    },
    act: (InboxCubit c) => c.load(),
    expect: () => <InboxState>[
      const InboxState(status: InboxStatus.loading),
      const InboxState(status: InboxStatus.failed, failure: NetworkFailure()),
    ],
  );
}

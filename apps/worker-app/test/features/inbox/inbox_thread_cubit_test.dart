import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/inbox/domain/inbox_models.dart';
import 'package:badabhai_worker_app/features/inbox/domain/inbox_repository.dart';
import 'package:badabhai_worker_app/features/inbox/presentation/cubit/inbox_thread_cubit.dart';
import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class MockInboxRepository extends Mock implements InboxRepository {}

InboxMessage _msg(String id, {required bool fromWorker}) => InboxMessage(
      messageId: id,
      fromWorker: fromWorker,
      text: 'x',
      createdAt: DateTime.utc(2026, 9, 21),
    );

void main() {
  late MockInboxRepository repo;

  setUp(() {
    repo = MockInboxRepository();
    when(() => repo.markRead(any())).thenAnswer((_) async {});
  });

  blocTest<InboxThreadCubit, InboxThreadState>(
    'load emits ready and marks the thread read',
    build: () {
      when(() => repo.thread('u1')).thenAnswer(
          (_) async => <InboxMessage>[_msg('m1', fromWorker: false)]);
      return InboxThreadCubit(repo);
    },
    act: (InboxThreadCubit c) => c.load('u1'),
    expect: () => <InboxThreadState>[
      const InboxThreadState(status: InboxThreadStatus.loading),
      InboxThreadState(
        status: InboxThreadStatus.ready,
        messages: <InboxMessage>[_msg('m1', fromWorker: false)],
      ),
    ],
    verify: (_) => verify(() => repo.markRead('u1')).called(1),
  );

  blocTest<InboxThreadCubit, InboxThreadState>(
    'a neutral body is the closed state, never a reason',
    build: () {
      when(() => repo.thread('u1')).thenAnswer((_) async => null);
      return InboxThreadCubit(repo);
    },
    act: (InboxThreadCubit c) => c.load('u1'),
    expect: () => <InboxThreadState>[
      const InboxThreadState(status: InboxThreadStatus.loading),
      const InboxThreadState(status: InboxThreadStatus.closed),
    ],
    verify: (_) => verifyNever(() => repo.markRead(any())),
  );

  test('reply returns true and reloads when the server accepts it', () async {
    when(() => repo.thread('u1'))
        .thenAnswer((_) async => <InboxMessage>[_msg('m1', fromWorker: false)]);
    when(() => repo.reply('u1', 'Haan')).thenAnswer((_) async => true);
    final InboxThreadCubit cubit = InboxThreadCubit(repo);
    await cubit.load('u1');

    final bool ok = await cubit.reply('Haan');

    expect(ok, isTrue);
    expect(cubit.state.status, InboxThreadStatus.ready);
    expect(cubit.state.sending, isFalse);
    verify(() => repo.reply('u1', 'Haan')).called(1);
  });

  test('reply on a closed thread returns false and flips to closed', () async {
    when(() => repo.thread('u1'))
        .thenAnswer((_) async => <InboxMessage>[_msg('m1', fromWorker: false)]);
    when(() => repo.reply('u1', 'Haan')).thenAnswer((_) async => false);
    final InboxThreadCubit cubit = InboxThreadCubit(repo);
    await cubit.load('u1');

    final bool ok = await cubit.reply('Haan');

    expect(ok, isFalse);
    expect(cubit.state.status, InboxThreadStatus.closed);
  });

  test('a send transport failure keeps the thread and records a sendError',
      () async {
    when(() => repo.thread('u1'))
        .thenAnswer((_) async => <InboxMessage>[_msg('m1', fromWorker: false)]);
    when(() => repo.reply('u1', 'Haan')).thenThrow(const NetworkFailure());
    final InboxThreadCubit cubit = InboxThreadCubit(repo);
    await cubit.load('u1');

    final bool ok = await cubit.reply('Haan');

    expect(ok, isFalse);
    expect(cubit.state.status, InboxThreadStatus.ready);
    expect(cubit.state.sendError, const NetworkFailure());
  });
}

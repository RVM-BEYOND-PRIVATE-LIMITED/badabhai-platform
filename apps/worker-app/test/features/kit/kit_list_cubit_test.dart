import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/features/kit/domain/interview_kit.dart';
import 'package:badabhai_worker_app/features/kit/domain/interview_kit_repository.dart';
import 'package:badabhai_worker_app/features/kit/presentation/cubit/kit_list_cubit.dart';

class MockInterviewKitRepository extends Mock
    implements InterviewKitRepository {}

const List<KitListItem> _items = <KitListItem>[
  KitListItem(
    tradeKey: 'cnc_operator',
    title: 'CNC Operator',
    subtitle: '15 sawaal · jawaab ke saath',
  ),
];

void main() {
  late MockInterviewKitRepository repo;
  setUp(() => repo = MockInterviewKitRepository());

  // bloc emits the first state even when it equals the initial `loading`.
  blocTest<KitListCubit, KitListState>(
    'load success -> loading then ready with the items',
    build: () {
      when(() => repo.listKits()).thenAnswer((_) async => _items);
      return KitListCubit(repo);
    },
    act: (KitListCubit c) => c.load(),
    expect: () => const <KitListState>[
      KitListState(status: KitListStatus.loading),
      KitListState(status: KitListStatus.ready, items: _items),
    ],
    verify: (_) => verify(() => repo.listKits()).called(1),
  );

  blocTest<KitListCubit, KitListState>(
    'load failure -> failed (not a stuck spinner)',
    build: () {
      when(() => repo.listKits()).thenThrow(const NetworkFailure());
      return KitListCubit(repo);
    },
    act: (KitListCubit c) => c.load(),
    expect: () => const <KitListState>[
      KitListState(status: KitListStatus.loading),
      KitListState(status: KitListStatus.failed),
    ],
  );
}

import 'package:bloc_test/bloc_test.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

import 'package:badabhai_worker_app/core/error/failure.dart';
import 'package:badabhai_worker_app/core/session/known_worker_facts_store.dart';
import 'package:badabhai_worker_app/features/name/domain/name_repository.dart';
import 'package:badabhai_worker_app/features/name/presentation/cubit/name_cubit.dart';

class MockNameRepository extends Mock implements NameRepository {}

void main() {
  late MockNameRepository repo;
  setUp(() => repo = MockNameRepository());

  blocTest<NameCubit, NameState>(
    'submit success -> submitting then success; sends the TRIMMED name',
    build: () {
      when(() => repo.submitName(any())).thenAnswer((_) async {});
      return NameCubit(repo);
    },
    act: (NameCubit c) => c.submit('  Asha Kumari  '),
    expect: () => const <NameState>[
      NameState(status: NameStatus.submitting),
      NameState(status: NameStatus.success),
    ],
    verify: (_) => verify(() => repo.submitName('Asha Kumari')).called(1),
  );

  blocTest<NameCubit, NameState>(
    'submit title-cases an all-lowercase name before sending it',
    build: () {
      when(() => repo.submitName(any())).thenAnswer((_) async {});
      return NameCubit(repo);
    },
    act: (NameCubit c) => c.submit('ramesh kumar'),
    expect: () => const <NameState>[
      NameState(status: NameStatus.submitting),
      NameState(status: NameStatus.success),
    ],
    verify: (_) => verify(() => repo.submitName('Ramesh Kumar')).called(1),
  );

  blocTest<NameCubit, NameState>(
    'submit failure -> submitting then failed (not a stuck spinner)',
    build: () {
      when(() => repo.submitName(any())).thenThrow(const NetworkFailure());
      return NameCubit(repo);
    },
    act: (NameCubit c) => c.submit('Asha'),
    expect: () => const <NameState>[
      NameState(status: NameStatus.submitting),
      NameState(status: NameStatus.failed),
    ],
  );

  test('a city the server saved is recorded as known; no city records nothing',
      () async {
    when(() => repo.submitName(any(),
        city: any(named: 'city'),
        state: any(named: 'state'))).thenAnswer((_) async {});
    final InMemoryKnownWorkerFactsStore facts = InMemoryKnownWorkerFactsStore();

    await NameCubit(repo, knownFacts: facts).submit('Asha');
    expect(await facts.knownFacts(), isEmpty,
        reason: 'a skipped location prompt leaves the city to the form');

    await NameCubit(repo, knownFacts: facts)
        .submit('Asha', city: 'faridabad', state: 'Haryana');
    expect(await facts.knownFacts(), <WorkerFact>{WorkerFact.currentCity});
  });

  test('a failed save records nothing', () async {
    when(() => repo.submitName(any(),
        city: any(named: 'city'),
        state: any(named: 'state'))).thenThrow(const NetworkFailure());
    final InMemoryKnownWorkerFactsStore facts = InMemoryKnownWorkerFactsStore();

    await NameCubit(repo, knownFacts: facts)
        .submit('Asha', city: 'Pune', state: 'Maharashtra');

    expect(await facts.knownFacts(), isEmpty);
  });

  blocTest<NameCubit, NameState>(
    'an empty/whitespace name is a no-op (no emit, no repo call)',
    build: () => NameCubit(repo),
    act: (NameCubit c) => c.submit('   '),
    expect: () => const <NameState>[],
    verify: (_) => verifyNever(() => repo.submitName(any())),
  );
}
